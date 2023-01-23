import { ApiPromise, WsProvider } from '@polkadot/api'

import { JoystreamLibError } from './errors'
import { Logger } from '@youtube-sync/domain'

import { JoystreamLibExtrinsics } from './extrinsics'
import { AccountId } from '@polkadot/types/interfaces'

export class JoystreamLib {
  readonly api: ApiPromise
  readonly extrinsics: JoystreamLibExtrinsics

  // if needed these could become some kind of event emitter
  public onNodeConnectionUpdate?: (connected: boolean) => unknown

  /* Lifecycle */
  constructor(endpoint: string) {
    const provider = new WsProvider(endpoint)
    provider.on('connected', () => {
      this.logConnectionData(endpoint)
      this.onNodeConnectionUpdate?.(true)
    })
    provider.on('disconnected', () => {
      this.onNodeConnectionUpdate?.(false)
    })
    provider.on('error', () => {
      this.onNodeConnectionUpdate?.(false)
    })

    this.api = new ApiPromise({ provider })
    this.api.isReadyOrError.catch((error) => error)
    this.extrinsics = new JoystreamLibExtrinsics(this.api)
  }

  destroy() {
    this.api.disconnect()
    Logger.info('[JoystreamLib] Destroyed')
  }

  private async ensureApi() {
    try {
      await this.api.isReady
    } catch (e) {
      Logger.error('Failed to initialize Polkadot API', e)
      throw new JoystreamLibError({ name: 'ApiNotConnectedError' })
    }
  }

  private async logConnectionData(endpoint: string) {
    await this.ensureApi()
    const chain = await this.api.rpc.system.chain()
    Logger.info(`[JoystreamLib] Connected to chain "${chain}" via "${endpoint}"`)
  }

  async connect() {
    await this.ensureApi()
  }

  async getAccountBalance(accountId: AccountId): Promise<number> {
    await this.ensureApi()

    const balance = await this.api.derive.balances.account(accountId)

    return balance.freeBalance.toBn().toNumber()
  }
}
