import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  NotFoundException,
  Param,
  ParseArrayPipe,
  ParseIntPipe,
  Post,
  Put,
  UnauthorizedException,
} from '@nestjs/common'
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'
import { signatureVerify } from '@polkadot/util-crypto'
import { randomBytes } from 'crypto'
import {
  ChannelDto,
  ChannelInductionRequirementsDto,
  IngestChannelDto,
  OptoutChannelDto,
  SaveChannelRequest,
  SaveChannelResponse,
  SuspendChannelDto,
  UserDto,
  VerifyChannelDto,
  VideoDto,
} from '../dtos'
import { IYoutubeApi } from '../../youtube/api'
import { QueryNodeApi } from '../../query-node/api'
import { DynamodbService } from '../../../repository'
import { YtChannel, YtUser, YtVideo } from '../../../types/youtube'

@Controller('channels')
@ApiTags('channels')
export class ChannelsController {
  constructor(
    @Inject('youtube') private youtubeApi: IYoutubeApi,
    private qnApi: QueryNodeApi,
    private dynamodbService: DynamodbService
  ) {}

  @ApiOperation({
    description: `Creates user from the supplied google authorization code and fetches
     user's channel and if it satisfies YPP induction criteria it saves the record`,
  })
  @ApiBody({ type: SaveChannelRequest })
  @ApiResponse({ type: SaveChannelResponse })
  @Post()
  async saveChannel(@Body() channelInfo: SaveChannelRequest): Promise<SaveChannelResponse> {
    try {
      const {
        userId,
        authorizationCode,
        email,
        joystreamChannelId,
        shouldBeIngested,
        videoCategoryId,
        referrerChannelId,
      } = channelInfo

      if (referrerChannelId === joystreamChannelId) {
        throw new Error('Referrer channel cannot be the same as the channel being verified.')
      }

      // get user from userId
      const user = await this.dynamodbService.users.get(userId)

      // ensure request's authorization code matches the user's authorization code
      if (user.authorizationCode !== authorizationCode) {
        throw new Error('Invalid request author. Permission denied.')
      }

      // get channel from user
      const channel = await this.youtubeApi.getChannel(user)

      // reset authorization code to prevent repeated save channel requests by authorization code re-use
      const updatedUser: YtUser = { ...user, email, authorizationCode: randomBytes(10).toString('hex') }

      const joystreamChannelLanguageIso = (await this.qnApi.getChannelById(joystreamChannelId.toString()))?.language
        ?.iso
      const updatedChannel: YtChannel = {
        ...channel,
        email,
        joystreamChannelId,
        shouldBeIngested,
        videoCategoryId,
        referrerChannelId,
        joystreamChannelLanguageIso,
      }

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
  async get(@Param('joystreamChannelId', ParseIntPipe) id: number) {
    try {
      const channel = await this.dynamodbService.channels.getByJoystreamChannelId(id)
      return new ChannelDto(channel)
    } catch (error) {
      const message = error instanceof Error ? error.message : error
      throw new NotFoundException(message)
    }
  }

  @Get()
  @ApiOperation({ description: 'Retrieves the most recently verified 30 channels desc by date' })
  @ApiResponse({ type: ChannelDto })
  async getRecentVerifiedChannels() {
    try {
      const channels = await this.dynamodbService.channels.getRecent(30)
      return channels.map((channel) => new ChannelDto(channel))
    } catch (error) {
      const message = error instanceof Error ? error.message : error
      throw new NotFoundException(message)
    }
  }

  @Put(':joystreamChannelId/ingest')
  @ApiBody({ type: IngestChannelDto })
  @ApiResponse({ type: ChannelDto })
  @ApiOperation({
    description: `Updates given channel ingestion/syncing status. Note: only channel owner can update the status`,
  })
  async ingestChannel(
    @Param('joystreamChannelId', ParseIntPipe) id: number,
    @Body() { message, signature }: IngestChannelDto
  ) {
    try {
      const channel = await this.dynamodbService.channels.getByJoystreamChannelId(id)

      // Ensure channel is not suspended or opted out
      if (channel.yppStatus === 'Suspended' || channel.yppStatus === 'OptedOut') {
        throw new Error(`Can't change ingestion status of a ${channel.yppStatus} channel. Permission denied.`)
      }

      const jsChannel = await this.qnApi.getChannelById(channel.joystreamChannelId.toString())
      if (!jsChannel || !jsChannel.ownerMember) {
        throw new Error(`Joystream Channel not found by ID ${id}.`)
      }

      // verify the message signature using Channel owner's address
      const { isValid } = signatureVerify(JSON.stringify(message), signature, jsChannel.ownerMember.controllerAccount)

      // Ensure that the signature is valid and the message is not a playback message
      if (!isValid || channel.lastActedAt >= message.timestamp) {
        throw new Error('Invalid request signature or playback message. Permission denied.')
      }

      // update channel ingestion status
      await this.dynamodbService.channels.save({
        ...channel,
        shouldBeIngested: message.shouldBeIngested,
        lastActedAt: message.timestamp,
        ...(message.videoCategoryId ? { videoCategoryId: message.videoCategoryId } : {}),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : error
      throw new NotFoundException(message)
    }
  }

  @Put(':joystreamChannelId/optout')
  @ApiBody({ type: OptoutChannelDto })
  @ApiResponse({ type: ChannelDto })
  @ApiOperation({
    description: `Updates given channel's YPP participation status. Note: only channel owner can update the status`,
  })
  async optoutChannel(
    @Param('joystreamChannelId', ParseIntPipe) id: number,
    @Body() { message, signature }: OptoutChannelDto
  ) {
    try {
      const channel = await this.dynamodbService.channels.getByJoystreamChannelId(id)

      // Ensure channel is not suspended
      if (channel.yppStatus === 'Suspended') {
        throw new Error(`Can't change YPP participation status of a suspended channel. Permission denied.`)
      }

      const jsChannel = await this.qnApi.getChannelById(channel.joystreamChannelId.toString())
      if (!jsChannel || !jsChannel.ownerMember) {
        throw new Error(`Joystream Channel not found by ID ${id}.`)
      }

      // verify the message signature using Channel owner's address
      const { isValid } = signatureVerify(JSON.stringify(message), signature, jsChannel.ownerMember.controllerAccount)

      // Ensure that the signature is valid and the message is not a playback message
      if (!isValid || channel.lastActedAt >= message.timestamp) {
        throw new Error('Invalid request signature or playback message. Permission denied.')
      }

      // update channel's ypp participation status
      await this.dynamodbService.channels.save({
        ...channel,
        yppStatus: message.optout ? 'OptedOut' : 'Unverified',
        shouldBeIngested: false,
        lastActedAt: message.timestamp,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : error
      throw new NotFoundException(message)
    }
  }

  @Put('/suspend')
  @ApiBody({ type: SuspendChannelDto, isArray: true })
  @ApiOperation({
    description: `Authenticated endpoint to suspend given channel/s from YPP program`,
  })
  async suspendChannels(
    @Headers('authorization') authorizationHeader: string,
    @Body(new ParseArrayPipe({ items: SuspendChannelDto, whitelist: true })) channels: SuspendChannelDto[]
  ) {
    const yppOwnerKey = authorizationHeader ? authorizationHeader.split(' ')[1] : ''
    // TODO: fix this YT_SYNCH__HTTP_API__OWNER_KEY config value
    if (yppOwnerKey !== process.env.YT_SYNCH__HTTP_API__OWNER_KEY) {
      throw new UnauthorizedException('Invalid YPP owner key')
    }

    try {
      for (const { joystreamChannelId, isSuspended } of channels) {
        const channel = await this.dynamodbService.channels.getByJoystreamChannelId(joystreamChannelId)

        // if channel is being suspended then its YT ingestion/syncing should also be stopped
        if (isSuspended) {
          await this.dynamodbService.channels.save({
            ...channel,
            yppStatus: 'Suspended',
            shouldBeIngested: false,
          })
        } else {
          // if channel suspension is revoked then its YT ingestion/syncing should not be resumed
          await this.dynamodbService.channels.save({ ...channel, yppStatus: 'Unverified' })
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : error
      throw new NotFoundException(message)
    }
  }

  @Put('/verify')
  @ApiBody({ type: SuspendChannelDto, isArray: true })
  @ApiOperation({
    description: `Authenticated endpoint to verify given channel/s in YPP program`,
  })
  async verifyChannels(
    @Headers('authorization') authorizationHeader: string,
    @Body(new ParseArrayPipe({ items: VerifyChannelDto, whitelist: true })) channels: VerifyChannelDto[]
  ) {
    const yppOwnerKey = authorizationHeader ? authorizationHeader.split(' ')[1] : ''
    // TODO: fix this YT_SYNCH__HTTP_API__OWNER_KEY config value
    if (yppOwnerKey !== process.env.YT_SYNCH__HTTP_API__OWNER_KEY) {
      throw new UnauthorizedException('Invalid YPP owner key')
    }

    try {
      for (const { joystreamChannelId, isVerified } of channels) {
        const channel = await this.dynamodbService.channels.getByJoystreamChannelId(joystreamChannelId)

        // channel is being verified
        if (isVerified) {
          await this.dynamodbService.channels.save({ ...channel, yppStatus: 'Verified' })
        } else {
          // channel is being unverified
          await this.dynamodbService.channels.save({ ...channel, yppStatus: 'Unverified' })
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : error
      throw new NotFoundException(message)
    }
  }

  @Get(':joystreamChannelId/videos')
  @ApiResponse({ type: VideoDto, isArray: true })
  @ApiOperation({
    description: `Retrieves all videos (in the backend system) for a given youtube channel by its corresponding joystream channel Id.`,
  })
  async getVideos(@Param('joystreamChannelId', ParseIntPipe) id: number): Promise<YtVideo[]> {
    try {
      const channelId = (await this.dynamodbService.channels.getByJoystreamChannelId(id)).id
      const result = await this.dynamodbService.repo.videos.query({ channelId }, (q) => q.sort('descending'))
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : error
      throw new NotFoundException(message)
    }
  }

  @Get(':id/videos/:videoId')
  @ApiResponse({ type: ChannelDto })
  @ApiOperation({ description: 'Retrieves particular video by it`s channel id' })
  async getVideo(@Param('id') id: string, @Param('videoId') videoId: string) {
    const result = await this.dynamodbService.repo.videos.get(id, videoId)
    return result
  }

  @Get('/induction/requirements')
  @ApiResponse({ type: ChannelInductionRequirementsDto })
  @ApiOperation({ description: 'Retrieves Youtube Partner program induction requirements' })
  async inductionRequirements() {
    return new ChannelInductionRequirementsDto({
      ...this.youtubeApi.getCreatorOnboardingRequirements(),
    })
  }

  private async saveUserAndChannel(user: YtUser, channel: YtChannel) {
    // save user
    await this.dynamodbService.users.save(user)

    // save channel
    return await this.dynamodbService.channels.save(channel)
  }
}
