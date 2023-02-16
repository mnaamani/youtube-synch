import { SnsClient, SyncService, YtClient } from '@joystream/ytube'
import { EventRuleEvent } from '@pulumi/aws/cloudwatch'
import { getConfig, setAwsConfig } from '@youtube-sync/domain'
import { JoystreamClient, Uploader } from '@youtube-sync/joy-api'

export async function ingestionScheduler(event: EventRuleEvent) {
  // Set AWS config in case we are running locally
  setAwsConfig()

  console.log('event: ', event)

  const { YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, JOYSTREAM_WEBSOCKET_RPC, JOYSTREAM_QUERY_NODE_URL } = getConfig()
  const youtubeClient = YtClient.create(YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET)
  const joystreamClient = new JoystreamClient(JOYSTREAM_WEBSOCKET_RPC, JOYSTREAM_QUERY_NODE_URL)
  const storageClient = new Uploader(JOYSTREAM_QUERY_NODE_URL)

  await new SyncService(youtubeClient, joystreamClient, storageClient, new SnsClient()).startChannelsIngestion()
}
