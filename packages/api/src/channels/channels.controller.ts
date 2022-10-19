import { ChannelsRepository, IYoutubeClient, UsersRepository, VideosRepository } from '@joystream/ytube'
import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Param, Post, Put } from '@nestjs/common'
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'
import { Channel, User } from '@youtube-sync/domain'
// eslint-disable-next-line @nrwl/nx/enforce-module-boundaries
import QueryNodeApi from 'packages/joy-api/src/graphql/QueryNodeApi'
import { ChannelDto, SaveChannelRequest, SaveChannelResponse, IngestChannelDto, UserDto, VideoDto } from '../dtos'
import { ChannelsService } from './channels.service'
import { stringToU8a, u8aToHex } from '@polkadot/util'
import { signatureVerify } from '@polkadot/util-crypto'

@Controller('channels')
@ApiTags('channels')
export class ChannelsController {
  constructor(
    @Inject('youtube') private youtube: IYoutubeClient,
    private channelsService: ChannelsService,
    private channelsRepository: ChannelsRepository,
    private usersRepository: UsersRepository,
    private videosRepository: VideosRepository,
    private qnApi: QueryNodeApi
  ) {}

  @ApiOperation({
    description: `Creates user from the supplied google authorization code and fetches
     user's channel and if it satisfies YPP induction criteria it saves the record`,
  })
  @ApiBody({ type: SaveChannelRequest })
  @ApiResponse({ type: SaveChannelResponse })
  @Post()
  async addVerifiedChannel(
    @Body() { authorizationCode, userId, joystreamChannelId, referrerChannelId, email }: SaveChannelRequest
  ): Promise<SaveChannelResponse> {
    try {
      // get user from userId
      const user = await this.usersRepository.get(userId)

      // ensure request's authorization code matches the user's authorization code
      if (user.authorizationCode !== authorizationCode) {
        throw new Error('Invalid request author. Permission denied.')
      }

      // get channel from user
      const [channel] = await this.youtube.getChannels(user)

      const updatedUser: User = { ...user, email }
      const updatedChannel: Channel = { ...channel, joystreamChannelId, referrerChannelId, email }

      // save user and channel
      await this.saveUserAndChannel(updatedUser, updatedChannel)

      // return user and channel
      return new SaveChannelResponse(new UserDto(updatedUser), new ChannelDto(updatedChannel))
    } catch (error) {
      const message = error instanceof Error ? error.message : error
      throw new BadRequestException(message)
    }
  }

  @Get(':joystreamChannelId')
  @ApiOperation({ description: 'Retrieves channel by joystreamChannelId' })
  @ApiResponse({ type: ChannelDto })
  async get(@Param('joystreamChannelId') id: string) {
    try {
      const channel = await this.channelsService.get(id)
      return new ChannelDto(channel)
    } catch (error) {
      const message = error instanceof Error ? error.message : error
      throw new NotFoundException(message)
    }
  }

  @Put(':joystreamChannelId/ingest')
  @ApiBody({ type: IngestChannelDto })
  @ApiResponse({ type: ChannelDto })
  @ApiOperation({
    description: `Updates given channel ingestion status. Note: only channel owner can update the status`,
  })
  async Channel(@Param('joystreamChannelId') id: string, @Body() { message, signature }: IngestChannelDto) {
    try {
      const channel = await this.channelsService.get(id)

      // Ensure channel is not suspended
      if (channel.isSuspended) {
        throw new Error(`Can't change ingestion status of a suspended channel. Permission denied.`)
      }

      const { controllerAccount } = (await this.qnApi.getChannelById(channel.joystreamChannelId.toString())).ownerMember

      // verify the message signature using Channel owner's address
      const { isValid } = signatureVerify(JSON.stringify(message), signature, controllerAccount)

      // Ensure that the signature is valid and the message is not a playback message
      if (!isValid || new Date(channel.shouldBeIngested.lastChangedAt) >= message.timestamp) {
        throw new Error('Invalid request signature or playback message. Permission denied.')
      }

      // update channel ingestion status
      this.channelsService.update({
        ...channel,
        shouldBeIngested: {
          status: message.shouldBeIngested,
          lastChangedAt: message.timestamp.getTime(),
        },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : error
      throw new NotFoundException(message)
    }
  }

  @Get(':id/videos')
  @ApiResponse({ type: VideoDto, isArray: true })
  @ApiOperation({
    description: `Retrieves already ingested(spotted on youtube and saved to the database) videos for a given channel.`,
  })
  async getVideos(@Param('userId') userId: string, @Param('id') id: string) {
    const result = await this.videosRepository.query({ channelId: id }, (q) => q.sort('descending'))
    return result
  }

  @Get(':id/videos/:videoId')
  @ApiResponse({ type: ChannelDto })
  @ApiOperation({ description: 'Retrieves particular video by it`s id' })
  async getVideo(@Param('id') id: string, @Param('videoId') videoId: string) {
    const result = await this.videosRepository.get(id, videoId)
    return result
  }

  private async saveUserAndChannel(user: User, channel: Channel) {
    // save user
    await this.usersRepository.save(user)

    // save channel
    return await this.channelsRepository.save(channel)
  }
}
