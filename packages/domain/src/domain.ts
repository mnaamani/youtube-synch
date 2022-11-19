import { MemberId } from '@joystream/types/primitives'

export class Channel {
  // Channel ID
  id: string

  // ID of the user that owns the channel
  userId: string

  // user provided email
  email: string

  // ID of the corresponding Joystream Channel
  joystreamChannelId: number

  // Referrer Joystream Channel ID
  referrerChannelId: number

  // Channel title
  title: string

  frequency: number

  // Channel description
  description: string

  // Youtube channel creation date
  publishedAt: string

  // record creation time
  createdAt: Date

  // channel thumbnails
  thumbnails: Thumbnails

  // Channel statistics
  statistics: {
    // Total views
    viewCount: number

    // Total comments
    commentCount: number

    // Total subscribers
    subscriberCount: number

    // Total videos
    videoCount: number
  }

  // Tier of Channel based on its subscriber's count
  tier: 1 | 2 | 3

  aggregatedStats: number

  // Channel owner's access token
  userAccessToken: string

  // Channel owner's refresh token
  userRefreshToken: string
  uploadsPlaylistId: string

  //
  shouldBeIngested: boolean

  // Channel suspension status
  isSuspended: boolean

  // Needs a dummy partition key on GSI to be able to query by createdAt fields
  timestampPartition: string
}

export interface IEvent {
  timestamp: number
  subject: string
}

export class ChannelSpotted implements IEvent {
  /**
   *
   */
  constructor(public channel: Channel, public timestamp: number) {}
  subject = 'channelSpotted'
}

export class IngestChannel implements IEvent {
  constructor(public channel: Channel, public timestamp: number) {
    this.channel = channel
    this.timestamp = timestamp
  }

  subject = 'ingestChannel'
}

export class UserCreated implements IEvent {
  constructor(public user: User, public timestamp: number) {
    this.user = user
    this.timestamp = timestamp
  }

  subject = 'userCreated'
}

export class UserIngestionTriggered implements IEvent {
  constructor(public user: User, public timestamp: number) {
    this.user = user
    this.timestamp = timestamp
  }

  subject = 'userIngestionTriggered'
}

export class VideoEvent implements IEvent {
  constructor(public state: VideoState, public videoId: string, public channelId: string, public timestamp: number) {
    this.subject = state
  }

  subject: string
}

export type Membership = {
  memberId: MemberId
  address: string
  secret: string
  suri: string
}

export class User {
  constructor(
    // Youtube user ID
    public id: string,

    // Youtube User email
    public email: string,

    // User access token
    public accessToken: string,

    // User refresh token
    public refreshToken: string,

    // User authorization code
    public authorizationCode: string,

    // Record created At timestamp
    public createdAt: Date
  ) {}

  membership: Membership
}

export type Thumbnails = {
  default: string
  medium: string
  high: string
  maxRes: string
  standard: string
}

export type VideoState = 'new' | 'uploadToJoystreamStarted' | 'uploadToJoystreamFailed' | 'uploadToJoystreamSucceeded'

export class Video {
  // Video ID
  id: string

  // Video URL
  url: string

  // Video title
  title: string

  // Video description
  description: string

  // Video's playlist ID
  playlistId: string

  resourceId: string

  // Video's channel ID
  channelId: string

  // Video thumbnails
  thumbnails: Thumbnails

  //
  state: VideoState
  destinationUrl: string

  // Video duration
  duration: string

  // Youtube video creation date
  publishedAt: string

  // record creation time
  createdAt: Date
}

export class Stats {
  quotaUsed = 0
  date: number = Date.now()
  partition = 'stats'
}

export const getImages = (channel: Channel) => {
  return [
    ...urlAsArray(channel.thumbnails.default),
    ...urlAsArray(channel.thumbnails.high),
    ...urlAsArray(channel.thumbnails.maxRes),
    ...urlAsArray(channel.thumbnails.medium),
    ...urlAsArray(channel.thumbnails.standard),
  ]
}

const urlAsArray = (url: string) => (url ? [url] : [])
