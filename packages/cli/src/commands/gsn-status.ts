import Web3 from 'web3'
import clear from 'clear'

import { ContractInteractor } from '@opengsn/common/dist/ContractInteractor'
import { HttpClient } from '@opengsn/common/dist/HttpClient'
import { HttpWrapper } from '@opengsn/common/dist/HttpWrapper'
import { GSNContractsDeployment } from '@opengsn/common/dist/GSNContractsDeployment'

import { getNetworkUrl, getRelayHubAddress, gsnCommander, networksBlockExplorers } from '../utils'
import { StatisticsManager } from '@opengsn/common/dist/statistics/StatisticsManager'
import { createCommandsLogger } from '../CommandsWinstonLogger'
import { CommandLineStatisticsPresenter } from '../CommandLineStatisticsPresenter'
import {
  CommandLineStatisticsPresenterConfig,
  defaultCommandLineStatisticsPresenterConfig
} from '../CommandLineStatisticsPresenterConfig'

const commander = gsnCommander(['n', 'h'])
  .parse(process.argv);

(async () => {
  const host = getNetworkUrl(commander.network)
  const relayHubAddress = getRelayHubAddress(commander.hub)

  if (relayHubAddress == null) {
    console.error('Please specify RelayHub address')
    process.exit(1)
  }

  const deployment: GSNContractsDeployment = { relayHubAddress }
  const logger = createCommandsLogger(commander.loglevel)
  const provider = new Web3.providers.HttpProvider(host)
  const contractInteractor = new ContractInteractor({ provider, logger, deployment })
  await contractInteractor.init()
  const timeout = 1000
  const httpClient = new HttpClient(new HttpWrapper({ timeout }), logger)

  const statusLogic = new StatisticsManager(contractInteractor, httpClient, logger)

  const statistics = await statusLogic.gatherStatistics()
  const blockExplorerUrl = networksBlockExplorers.get(commander.network)
  const presenterConfig: CommandLineStatisticsPresenterConfig =
    Object.assign({}, defaultCommandLineStatisticsPresenterConfig, { blockExplorerUrl })
  const statisticsStringPresentation = new CommandLineStatisticsPresenter(presenterConfig)
    .getStatisticsStringPresentation(statistics)
  clear()
  console.log(statisticsStringPresentation)
})().catch(
  reason => {
    console.error(reason)
    process.exit(1)
  }
)
