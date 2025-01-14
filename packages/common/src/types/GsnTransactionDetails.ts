import { Address, IntString } from './Aliases'
import { PrefixedHexString } from 'ethereumjs-tx'

export interface GsnTransactionDetails {
  // Added by the Web3 call stack:
  readonly from: Address
  readonly data: PrefixedHexString
  readonly to: Address

  readonly value?: IntString
  /**
   * TODO: this is horrible. Think about it some more
   * Do not set this value manually as this value will be overwritten. Use {@link forceGasPrice} instead.
   */
  gas?: PrefixedHexString
  gasPrice?: PrefixedHexString

  // Required parameters for GSN, but assigned later
  readonly forwarder?: Address
  readonly paymaster?: Address

  readonly paymasterData?: PrefixedHexString
  readonly clientId?: IntString

  // Optional parameters for RelayProvider only:
  /**
   * Set to 'false' to create a direct transaction
   */
  readonly useGSN?: boolean

  /**
   * Use this to force the {@link RelayClient} to use provided gas price instead of calculated one.
   */
  readonly forceGasPrice?: PrefixedHexString
}
