const data = require('./data')
const { defaultFromAccount, ether, getRelayHub, getPenalizer, getStakeManager, getPaymaster } = require('./helpers')
const { merge } = require('lodash')

async function deployRelayHub (web3, options = {}) {
  const defaultOptions = {
    from: await defaultFromAccount(web3, options && options.from)
  }

  options = merge(defaultOptions, options)

  if (options.verbose) console.error(`Deploying RelayHub instance`)
  const stakeManager = getStakeManager(web3)
  const sInstance = await stakeManager.deploy({
    data: data.stakeManager.bytecode
  }).send({from: options.from,
    gas:1e8,
    gasPrice: 1e9,
  })
  const penalizer = getPenalizer(web3)
  const pInstance = await penalizer.deploy({
    data: data.penalizer.bytecode
  }).send({from: options.from,
    gas:1e8,
    gasPrice: 1e9,
  })
  const relayHub = getRelayHub(web3)
  console.log('stakeManager ', sInstance.options.address)
  console.log('penalizer ', pInstance.options.address)
  const rInstance = await relayHub.deploy({
    arguments: [16, sInstance.options.address, pInstance.options.address],

  }).send({from: options.from,
    gas:1e8,
    gasPrice: 1e9,
    })
  const paymaster = getPaymaster(web3)
  const pmInstance = await paymaster.deploy({
  }).send({from: options.from,
    gas:1e8,
    gasPrice: 1e9,
  })
  console.log('paymaster ', pmInstance.options.address)
  if (options.verbose) console.error(`RelayHub deployed at ${rInstance.options.address}`)

  return relayHub.address
}

module.exports = {
  deployRelayHub
}
