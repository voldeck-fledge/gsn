import { ether, expectEvent, expectRevert } from '@openzeppelin/test-helpers'
import BN from 'bn.js'

import { getEip712Signature } from '@opengsn/common/dist/Utils'
import { RelayRequest } from '@opengsn/common/dist/EIP712/RelayRequest'
import { TypedRequestData } from '@opengsn/common/dist/EIP712/TypedRequestData'

import {
  RelayHubInstance,
  PenalizerInstance,
  StakeManagerInstance,
  TestRecipientInstance,
  ForwarderInstance,
  TestPaymasterConfigurableMisbehaviorInstance
} from '@opengsn/contracts/types/truffle-contracts'
import { PrefixedHexString } from 'ethereumjs-tx'
import { ForwardRequest } from '@opengsn/common/dist/EIP712/ForwardRequest'
import { RelayData } from '@opengsn/common/dist/EIP712/RelayData'
import { deployHub, encodeRevertReason } from './TestUtils'
import { registerForwarderForGsn } from '@opengsn/common/dist/EIP712/ForwarderUtil'
import { toBuffer } from 'ethereumjs-util'
import { defaultEnvironment } from '@opengsn/common/dist/Environments'

const StakeManager = artifacts.require('StakeManager')
const Forwarder = artifacts.require('Forwarder')
const Penalizer = artifacts.require('Penalizer')
const TestUtil = artifacts.require('TestUtil')
const TestRecipient = artifacts.require('TestRecipient')
const TestPaymasterConfigurableMisbehavior = artifacts.require('TestPaymasterConfigurableMisbehavior')

interface PartialRelayRequest {
  request?: Partial<ForwardRequest>
  relayData?: Partial<RelayData>
}

// given partial request, fill it in from defaults, and return request and signature to send.
// if nonce is not explicitly specified, read it from forwarder
async function makeRequest (web3: Web3, req: PartialRelayRequest, defaultRequest: RelayRequest, chainId: number, forwarderInstance: ForwarderInstance): Promise<{ req: RelayRequest, sig: PrefixedHexString }> {
  const filledRequest = {
    request: { ...defaultRequest.request, ...req.request },
    relayData: { ...defaultRequest.relayData, ...req.relayData }
  }
  // unless explicitly set, read nonce from network.
  if ((filledRequest.request.nonce ?? '0') === '0') {
    filledRequest.request.nonce = (await forwarderInstance.getNonce(filledRequest.request.from)).toString()
  }

  const sig = await getEip712Signature(
    web3,
    new TypedRequestData(
      chainId,
      filledRequest.relayData.forwarder,
      filledRequest
    )
  )
  return {
    req: filledRequest,
    sig
  }
}

// verify the paymaster's commitment:
// - PM always pay for non-reverted TXs (either high or low gas use)
// - if preRelayedCall reverts: PM always pay (=as long as commitment>preRelayedCallGasLimit)
// - standard forwarder reverts: PM always pay (since commitment > gas of (preRelayedCall,forwarder))
// - nonstandard forwarder: PM pays above commitment
// - trusted recipient: PM pays above commitment.
contract('Paymaster Commitment', function ([_, relayOwner, relayManager, relayWorker, senderAddress, other]) { // eslint-disable-line no-unused-vars
  const RelayCallStatusCodes = {
    OK: new BN('0'),
    RelayedCallFailed: new BN('1'),
    RejectedByPreRelayed: new BN('2'),
    RejectedByForwarder: new BN('3'),
    RejectedByRecipientRevert: new BN('4'),
    PostRelayedFailed: new BN('5'),
    PaymasterBalanceChanged: new BN('6')
  }

  let chainId: number

  let relayHub: string
  let stakeManager: StakeManagerInstance
  let penalizer: PenalizerInstance
  let relayHubInstance: RelayHubInstance
  let recipientContract: TestRecipientInstance
  let paymasterContract: TestPaymasterConfigurableMisbehaviorInstance
  let forwarderInstance: ForwarderInstance
  let target: string
  let paymaster: string
  let forwarder: string

  const baseRelayFee = '0'
  const pctRelayFee = '0'

  before(async function () {
    stakeManager = await StakeManager.new(defaultEnvironment.maxUnstakeDelay)
    penalizer = await Penalizer.new(defaultEnvironment.penalizerConfiguration.penalizeBlockDelay, defaultEnvironment.penalizerConfiguration.penalizeBlockExpiration)
    relayHubInstance = await deployHub(stakeManager.address, penalizer.address)

    forwarderInstance = await Forwarder.new()
    forwarder = forwarderInstance.address
    recipientContract = await TestRecipient.new(forwarder)

    const testUtil = await TestUtil.new()
    chainId = (await testUtil.libGetChainID()).toNumber()

    await registerForwarderForGsn(forwarderInstance)

    target = recipientContract.address
    relayHub = relayHubInstance.address

    await stakeManager.setRelayManagerOwner(relayOwner, { from: relayManager })
    await stakeManager.stakeForRelayManager(relayManager, 1000, {
      value: ether('2'),
      from: relayOwner
    })
    await stakeManager.authorizeHubByOwner(relayManager, relayHub, { from: relayOwner })

    await relayHubInstance.addRelayWorkers([relayWorker], { from: relayManager })
    await relayHubInstance.registerRelayServer(baseRelayFee, pctRelayFee, 'url', { from: relayManager })
  })

  describe('paymaster commitments', function () {
    const gasPrice = '1'
    const gasLimit = '1000000'
    const senderNonce = '0'
    let sharedRelayRequestData: RelayRequest
    const paymasterData = '0x'
    const clientId = '1'
    const externalGasLimit = 5e6

    beforeEach(async () => {
      // brand new paymaster for each test...
      paymasterContract = await TestPaymasterConfigurableMisbehavior.new()
      paymaster = paymasterContract.address
      await paymasterContract.setTrustedForwarder(forwarder)
      await paymasterContract.setRelayHub(relayHub)
      await relayHubInstance.depositFor(paymaster, {
        value: ether('1'),
        from: other
      })

      sharedRelayRequestData = {
        request: {
          to: target,
          data: '',
          from: senderAddress,
          nonce: senderNonce,
          value: '0',
          gas: gasLimit,
          validUntil: '0'
        },
        relayData: {
          pctRelayFee,
          baseRelayFee,
          gasPrice,
          relayWorker,
          forwarder,
          paymaster,
          paymasterData,
          clientId
        }
      }
    })

    let paymasterBalance: BN
    beforeEach(async () => {
      paymasterBalance = (await relayHubInstance.balanceOf(paymaster))
    })

    it('paymaster should pay for normal request', async () => {
      const r = await makeRequest(web3, {
        request: {
          // nonce: '4',
          data: recipientContract.contract.methods.emitMessage('').encodeABI()
        },
        relayData: { paymaster }

      }, sharedRelayRequestData, chainId, forwarderInstance)

      const res = await relayHubInstance.relayCall(10e6, r.req, r.sig, '0x', externalGasLimit, {
        from: relayWorker,
        gas: externalGasLimit,
        gasPrice
      })
      // gasPrice is '1', so price=gasUsed...
      expectEvent(res, 'TransactionRelayed', { status: '0' })

      const gasUsed = res.receipt.gasUsed
      const paid = paymasterBalance.sub(await relayHubInstance.balanceOf(paymaster)).toNumber()
      // console.log('actual paid=', paid, 'gasUsed=', gasUsed, 'diff=', paid - gasUsed)
      assert.closeTo(paid, gasUsed, 50)
    })

    it('paymaster should not pay for requests exceeding msg.data size limit', async () => {
      const r = await makeRequest(web3, {
        request: {
          // nonce: '4',
          data: recipientContract.contract.methods.emitMessage('').encodeABI()
        },
        relayData: { paymaster }

      }, sharedRelayRequestData, chainId, forwarderInstance)
      const gasAndDataLimits = await paymasterContract.getGasAndDataLimits()
      const hugeApprovalData = '0x' + 'ef'.repeat(parseInt(gasAndDataLimits.calldataSizeLimit))
      await expectRevert(
        relayHubInstance.relayCall(10e6, r.req, r.sig, hugeApprovalData, externalGasLimit, {
          from: relayWorker,
          gas: externalGasLimit,
          gasPrice
        }), 'msg.data exceeded limit'
      )
    })

    it('paymaster should not pay for requests with max msg.data size if it rejects in pre', async () => {
      await paymasterContract.setRevertPreRelayCall(true)
      const r = await makeRequest(web3, {
        request: {
          // nonce: '4',
          data: recipientContract.contract.methods.emitMessage('').encodeABI()
        },
        relayData: { paymaster }

      }, sharedRelayRequestData, chainId, forwarderInstance)

      const gasAndDataLimits = await paymasterContract.getGasAndDataLimits()
      const hugeApprovalData = '0x' + 'ef'.repeat(parseInt(gasAndDataLimits.calldataSizeLimit) - 1030)
      const relayCallParams: [number, RelayRequest, string, string, number, Truffle.TransactionDetails?] = [10e6, r.req, r.sig, hugeApprovalData, externalGasLimit]
      const method = relayHubInstance.contract.methods.relayCall(...relayCallParams)
      assert.equal(gasAndDataLimits.calldataSizeLimit, toBuffer(method.encodeABI()).length.toString(),
        'relayCall() msg.data should be set to max size')
      const txdetails: Truffle.TransactionDetails = {
        from: relayWorker,
        gas: externalGasLimit,
        gasPrice
      }
      relayCallParams.push(txdetails)
      const res = await relayHubInstance.relayCall(...relayCallParams)
      expectEvent(res, 'TransactionRejectedByPaymaster', { reason: encodeRevertReason('You asked me to revert, remember?') })
    })

    it('paymaster should not pay for requests with max msg.data size if it accepts in pre but forwarder fails', async () => {
      const r = await makeRequest(web3, {
        request: {
          nonce: '11141212',
          data: recipientContract.contract.methods.emitMessage('').encodeABI()
        },
        relayData: { paymaster }

      }, sharedRelayRequestData, chainId, forwarderInstance)

      const gasAndDataLimits = await paymasterContract.getGasAndDataLimits()
      const hugeApprovalData = '0x' + 'ef'.repeat(parseInt(gasAndDataLimits.calldataSizeLimit) - 1030)
      const relayCallParams: [number, RelayRequest, string, string, number, Truffle.TransactionDetails?] = [10e6, r.req, r.sig, hugeApprovalData, externalGasLimit]
      const method = relayHubInstance.contract.methods.relayCall(...relayCallParams)
      assert.equal(gasAndDataLimits.calldataSizeLimit, toBuffer(method.encodeABI()).length.toString(),
        'relayCall() msg.data should be set to max size')
      const txdetails: Truffle.TransactionDetails = {
        from: relayWorker,
        gas: externalGasLimit,
        gasPrice
      }
      relayCallParams.push(txdetails)
      const res = await relayHubInstance.relayCall(...relayCallParams)
      expectEvent(res, 'TransactionRejectedByPaymaster', { reason: encodeRevertReason('FWD: nonce mismatch') })
    })

    it('paymaster should not change its acceptanceBudget before transaction', async () => {
      // the protocol of the relay to perform a view function of relayCall(), and then
      // issue it on-chain.
      // this test comes to verify the paymaster didn't change its acceptanceBalance between these
      // calls to a higher value.
      // it is assumed that the relay already made the view function and validated the acceptanceBalance to
      // be small, and now making a 2nd call on-chain, but with the acceptanceBalance as parameter.
      // the RELAYER (not paymaster) will pay for this reject - but at least it is very small, as it is
      // "fails-fast", as one of the first validation tests in relayCall
      const r = await makeRequest(web3, {
        request: {
          // nonce: '4',
          data: recipientContract.contract.methods.emitMessage('').encodeABI()
        },
        relayData: { paymaster }

      }, sharedRelayRequestData, chainId, forwarderInstance)

      const gasLimits = await paymasterContract.getGasAndDataLimits()
      const maxAcceptanceBudget = parseInt(gasLimits.acceptanceBudget)
      // fail if a bit lower
      expectRevert(relayHubInstance.relayCall(maxAcceptanceBudget - 1, r.req, r.sig, '0x', externalGasLimit, {
        from: relayWorker,
        gas: externalGasLimit,
        gasPrice
      }), 'acceptance budget too high')

      // but succeed if the value is OK
      const res = await relayHubInstance.relayCall(maxAcceptanceBudget, r.req, r.sig, '0x', externalGasLimit, {
        from: relayWorker,
        gas: externalGasLimit,
        gasPrice
      })
      expectEvent(res, 'TransactionRelayed', { status: '0' })
    })

    it('2nd payment should be 15k cheaper for relay than paymaster', async () => {
      // we can't do much about it: gasleft doesn't take into account "refunds", so
      //  we charge paymaster for reported gas, even though the evm will refund (the relay)
      //  at the end for some of it.
      //  if the paymaster's pre/post calls cause more refund, it will ALSO benefit the relayer, not the paymaster.
      //  NOTE: this means that
      //  GAS TOKENS CAN'T BE USED BY PAYMASTER - unless it is the same owner of relay and paymaster,

      const r = await makeRequest(web3, {
        request: {
          data: recipientContract.contract.methods.emitMessage('').encodeABI()
        }
      }, sharedRelayRequestData, chainId, forwarderInstance)

      const res = await relayHubInstance.relayCall(10e6, r.req, r.sig, '0x', externalGasLimit, {
        from: relayWorker,
        gas: externalGasLimit,
        gasPrice
      })
      // gasPrice is '1', so price=gasUsed...
      const gasUsed = res.receipt.gasUsed
      expectEvent(res, 'TransactionRelayed', { status: '0' })

      const paymasterPaid = paymasterBalance.sub(await relayHubInstance.balanceOf(paymaster)).toNumber()
      assert.closeTo(paymasterPaid, parseInt(gasUsed) + 15000, 50)
    })

    it('paymaster should not have preRelayedCall gas limit > acceptance budget', async () => {
      const limits = await paymasterContract.getGasAndDataLimits()
      await paymasterContract.setGasLimits(
        limits.acceptanceBudget,
        parseInt(limits.preRelayedCallGasLimit) + parseInt(limits.acceptanceBudget),
        limits.postRelayedCallGasLimit
      )
      const r = await makeRequest(web3, {
        request: {
          // nonce: '4',
          data: recipientContract.contract.methods.emitMessage('').encodeABI()
        },
        relayData: { paymaster }

      }, sharedRelayRequestData, chainId, forwarderInstance)

      expectRevert(relayHubInstance.relayCall(10e6, r.req, r.sig, '0x', externalGasLimit, {
        from: relayWorker,
        gas: externalGasLimit,
        gasPrice
      }), 'acceptance budget too low')
    })

    it('paymaster should not pay for reverts in preRelayedCall under acceptance budget', async () => {
      await paymasterContract.setOutOfGasPre(true)
      const r = await makeRequest(web3, {
        request: {
          // nonce: '4',
          data: recipientContract.contract.methods.emitMessage('').encodeABI()
        },
        relayData: { paymaster }

      }, sharedRelayRequestData, chainId, forwarderInstance)

      const res = await relayHubInstance.relayCall(10e6, r.req, r.sig, '0x', externalGasLimit, {
        from: relayWorker,
        gas: externalGasLimit,
        gasPrice
      })

      expectEvent(res, 'TransactionRejectedByPaymaster', { reason: null })

      const paid = paymasterBalance.sub(await relayHubInstance.balanceOf(paymaster)).toNumber()
      assert.equal(paid, 0)
    })

    it('paymaster should not pay for Forwarder revert (under commitment gas)', async () => {
      // NOTE: as long as commitment > preRelayedCallGasLimit
      const r = await makeRequest(web3, {
        request: {
          nonce: '4',
          data: recipientContract.contract.methods.emitMessage('').encodeABI()
        },
        relayData: { paymaster }

      }, sharedRelayRequestData, chainId, forwarderInstance)

      const res = await relayHubInstance.relayCall(10e6, r.req, r.sig, '0x', externalGasLimit, {
        from: relayWorker,
        gas: externalGasLimit,
        gasPrice
      })

      expectEvent(res, 'TransactionRejectedByPaymaster', { reason: encodeRevertReason('FWD: nonce mismatch') })

      const paid = paymasterBalance.sub(await relayHubInstance.balanceOf(paymaster)).toNumber()
      assert.equal(paid, 0)
    })

    it('paymaster SHOULD pay for Forwarder revert ABOVE commitment', async () => {
      // instead of creating a custom forwarder with takes a lot of gas, we lower
      // the commitment, so normal paymaster will be above it.
      // TODO fix this voodoo
      await paymasterContract.setGasLimits(12000, 12000, 10000)

      // NOTE: as long as commitment > preRelayedCallGasLimit
      const r = await makeRequest(web3, {
        request: {
          nonce: '4',
          data: recipientContract.contract.methods.emitMessage('').encodeABI()
        },
        relayData: { paymaster }

      }, sharedRelayRequestData, chainId, forwarderInstance)

      const res = await relayHubInstance.relayCall(10e6, r.req, r.sig, '0x', externalGasLimit, {
        from: relayWorker,
        gas: externalGasLimit,
        gasPrice
      })

      expectEvent(res, 'TransactionRelayed', { status: RelayCallStatusCodes.RejectedByForwarder })
    })

    it('paymaster should not pay for trusted-recipient revert (within commitment)', async () => {
      await paymasterContract.setTrustRecipientRevert(true)
      const r = await makeRequest(web3, {
        request: {
          data: recipientContract.contract.methods.testRevert().encodeABI()
        },
        relayData: { paymaster }

      }, sharedRelayRequestData, chainId, forwarderInstance)

      const res = await relayHubInstance.relayCall(10e6, r.req, r.sig, '0x', externalGasLimit, {
        from: relayWorker,
        gas: externalGasLimit,
        gasPrice
      })

      expectEvent(res, 'TransactionRejectedByPaymaster', { reason: encodeRevertReason('always fail') })

      const paid = paymasterBalance.sub(await relayHubInstance.balanceOf(paymaster)).toNumber()
      assert.equal(paid, 0)
    })

    it('paymaster SHOULD pay for trusted-recipient revert (above commitment)', async () => {
      // TODO fix this voodoo
      await paymasterContract.setGasLimits(12000, 12000, 10000)

      await paymasterContract.setTrustRecipientRevert(true)
      const r = await makeRequest(web3, {
        request: {
          data: recipientContract.contract.methods.testRevert().encodeABI()
        },
        relayData: { paymaster }

      }, sharedRelayRequestData, chainId, forwarderInstance)

      const res = await relayHubInstance.relayCall(10e6, r.req, r.sig, '0x', externalGasLimit, {
        from: relayWorker,
        gas: externalGasLimit,
        gasPrice
      })

      expectEvent(res, 'TransactionRelayed', { status: RelayCallStatusCodes.RejectedByRecipientRevert })
    })
  })
})
