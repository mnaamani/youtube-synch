import {
  Channel,
  ChannelSpotted,
  IngestChannel,
  Logger,
  User,
  Video,
  VideoEvent,
  VideoStates,
  toPrettyJSON,
} from '@youtube-sync/domain'
import { JoystreamClient, Uploader } from '@youtube-sync/joy-api'
import { GaxiosError } from 'gaxios/build/src/common'
import { ChannelsRepository, UsersRepository, VideosRepository } from './database'
import { Frequency } from './frequency'
import { SnsClient } from './messageBus'
import { ISyncService, JoystreamSyncService } from './uploadService'
import { IYoutubeClient } from './youtubeClient'

export class SyncService {
  private syncService: ISyncService
  private channelsRepository: ChannelsRepository
  private usersRepository: UsersRepository
  private videosRepository: VideosRepository

  constructor(
    private youtube: IYoutubeClient,
    private joystreamClient: JoystreamClient,
    private storageClient: Uploader,
    private snsClient: SnsClient
  ) {
    this.syncService = new JoystreamSyncService(this.joystreamClient, this.storageClient)
    this.channelsRepository = new ChannelsRepository()
    this.usersRepository = new UsersRepository()
    this.videosRepository = new VideosRepository()
  }

  async getVideosRepo() {
    return this.videosRepository
  }

  async getChannelsRepo() {
    return this.channelsRepository
  }

  // get all videos with updated state
  private async getUpdatedVideos(channel: Channel, newVideos: Video[]): Promise<Video[]> {
    // Get all the existing videos
    const existingVideos = await this.videosRepository.query({ channelId: channel.id }, (q) => q)

    // Return updated video objects
    return newVideos.map((newVideo) => {
      const existingVideo = existingVideos.find((v) => v.id === newVideo.id)
      if (existingVideo) {
        // If video already exists, return the existing video object with updated properties
        return {
          ...newVideo,
          createdAt: existingVideo.createdAt,
          state: existingVideo.state,
          joystreamVideo: existingVideo.joystreamVideo,
        }
      } else {
        return newVideo
      }
    })
  }

  async startIngestionFor(frequencies: Frequency[]) {
    // get all channels that need to be ingested based on following conditions:
    // 1. `yppStatus` flag should be set to  `Active`
    // 2. `shouldBeIngested` flag should be set to true
    const channelsToBeIngested = await this.channelsRepository.scan('frequency', (s) =>
      s
        .in(frequencies)
        .filter('yppStatus')
        .eq('Verified')
        .or()
        .filter('yppStatus')
        .eq('Unverified')
        .and()
        .filter('shouldBeIngested')
        .eq(true)
    )

    // updated channel objects with latest subscriber count info
    const updatedChannels = await Promise.all(
      channelsToBeIngested.map(async (ch): Promise<Channel> => {
        try {
          const [channel] = await this.youtube.getChannels({
            id: ch.userId,
            accessToken: ch.userAccessToken,
            refreshToken: ch.userRefreshToken,
          })

          return { ...ch, statistics: channel.statistics }
        } catch (error: unknown) {
          // set `shouldBeIngested` to false, if app permission is revoked by user from Google account, because
          // then trying to fetch user channel will throw error with code 400 and 'invalid_grant' message
          if (error instanceof GaxiosError && error.code === '400' && error.response?.data?.error === 'invalid_grant') {
            return {
              ...ch,
              yppStatus: 'OptedOut',
              shouldBeIngested: false,
              lastActedAt: new Date(),
            }
          }

          return ch
        }
      })
    )

    // save updated  channels
    await this.channelsRepository.upsertAll(updatedChannels)

    // create channels event
    const channelsEvent = channelsToBeIngested.map((ch) => new IngestChannel(ch, new Date()))

    // publish events
    return this.snsClient.publishAll(channelsEvent, 'channelEvents')
  }

  async ingestChannels(user: User) {
    // fetch all channels of user from youtube API
    const channels = await this.youtube.getChannels(user)

    // save channels
    await this.channelsRepository.upsertAll(channels)

    // update user channels count
    this.usersRepository.save(user)

    // create channel events
    const channelEvents = channels.map((ch) => new ChannelSpotted(ch, new Date()))

    // publish events
    return this.snsClient.publishAll(channelEvents, 'channelEvents')
  }

  async ingestAllVideos(channel: Channel, top: number) {
    // get all videos of the channel
    const allVideos = await this.youtube.getAllVideos(channel, top)

    // get all updated videos
    const updatedVideos = await this.getUpdatedVideos(channel, allVideos)

    // save all updated videos to DB as some fields might have changed, e.g. viewCount
    await this.videosRepository.upsertAll(updatedVideos)

    // create video events
    const videoEvents = updatedVideos.reduce((events: VideoEvent[], v) => {
      if (v.state === 'New' || v.state === 'VideoCreationFailed') {
        events.push(new VideoEvent(v.state, v.id, v.title, v.channelId, new Date()))
      }
      return events
    }, [])

    // publish events
    return this.snsClient.publishAll(videoEvents, 'createVideoEvents')
  }

  async createVideo(channelId: string, videoId: string) {
    // Load channel
    const channel = await this.channelsRepository.get(channelId)
    if (!channel) {
      throw new Error(`Channel with id ${channelId} not found`)
    }

    // Load Video
    const video = await this.videosRepository.get(channelId, videoId)
    if (!video) {
      throw new Error(`Video with id ${videoId} not found in channel ${channelId}`)
    }

    // if video hasn't finished processing on Youtube, it's a private
    // video, or it has been already created, then don't sync it yet
    if (
      video.uploadStatus !== 'processed' ||
      video.privacyStatus === 'private' ||
      VideoStates[video.state] >= VideoStates.VideoCreated
    ) {
      return
    }

    try {
      // Update video state and save to DB
      await this.videosRepository.save({ ...video, state: 'CreatingVideo' })

      // Create video on joystream blockchain by calling extrinsic
      const { joystreamVideo } = await this.syncService.createVideo(channel, video)

      Logger.info(`Created new video ${toPrettyJSON(joystreamVideo)}`)

      // Update video state and save to DB
      await this.videosRepository.save({ ...video, joystreamVideo, state: 'VideoCreated' })

      // upload video event
      const videoCreatedEvent = new VideoEvent('VideoCreated', video.id, video.title, video.channelId, new Date())

      // publish upload video event
      return this.snsClient.publish(videoCreatedEvent, 'uploadVideoEvents')
    } catch (error) {
      // Update video state and save to DB
      await this.videosRepository.save({ ...video, state: 'VideoCreationFailed' })

      // video creation failed event
      const VideoCreationFailedEvent = new VideoEvent(
        'VideoCreationFailed',
        video.id,
        video.title,
        video.channelId,
        new Date()
      )

      // publish video creation failed event
      return this.snsClient.publish(VideoCreationFailedEvent, 'createVideoEvents')
    }
  }

  async uploadVideo(channelId: string, videoId: string) {
    const channel = await this.channelsRepository.get(channelId)
    if (!channel) {
      throw new Error(`Channel with id ${channelId} not found`)
    }

    // Load Video
    const video = await this.videosRepository.get(channelId, videoId)
    if (!video) {
      throw new Error(`Video with id ${videoId} not found in channel ${channelId}`)
    }

    try {
      // Update video state and save to DB
      await this.videosRepository.save({ ...video, state: 'UploadStarted' })

      // Upload the video assets
      await this.syncService.uploadVideo(channel, video)

      // Update video state and save to DB
      await this.videosRepository.save({ ...video, state: 'UploadSucceeded' })
    } catch (error) {
      // Update video state and save to DB
      await this.videosRepository.save({ ...video, state: 'UploadFailed' })

      // upload video event
      const uploadFailedEvent = new VideoEvent('UploadFailed', video.id, video.title, video.channelId, new Date())

      // publish upload video event
      return this.snsClient.publish(uploadFailedEvent, 'uploadVideoEvents')
    }
  }
}
