import _ from 'lodash'
import { loadConfig as config } from './config'
import { countVideosSyncedAfter, getAllVerifiedChannels, latestReferrerRewardInUsd } from './dynamodb'
import { createYppContacts, getAllYppContacts, mapDynamoItemToContactFields, updateYppContact } from './hubspot'
import { HubspotYPPContact } from './types'

function latestSyncRewardInUsd({ tier, syncedCount }: { tier: number; syncedCount: number }): number {
  const perSyncedVideoReward = tier - 1
  const maxRewardedVideos = Math.min(syncedCount, config('MAX_REWARDED_VIDEOS_PER_WEEK'))

  return perSyncedVideoReward * maxRewardedVideos
}

export async function updateHubspotWithCalculatedRewards() {
  const contacts = await getAllYppContacts()
  for (const contact of contacts) {
    // If the contact record is already checked & updated for this cycle, skip
    if (contact.latestDateChecked === new Date().toISOString().split('T')[0]) {
      console.log(`Already Checked For this Cycle`, contact.gleev_channel_id)
      continue
    }

    const syncedCount = await countVideosSyncedAfter(
      contact.channelId,
      contact.latestDateChecked || contact.dateSignedUpToYpp
    )

    const rewardMultiplier = contact.tier == 1 ? 1 : contact.tier == 2 ? 2.5 : 5

    // If this is the first time we are checking for this channel contact, we should give them the sign up reward
    let sign_up_reward_in_usd =
      contact.latestDateChecked === null || contact.latestDateChecked === ''
        ? config(`TIER_${contact.tier}_SIGNUP_REWARD_IN_USD`)
        : 0
    let latest_referral_reward_in_usd = await latestReferrerRewardInUsd(
      contact.gleev_channel_id,
      contact.latestDateChecked || contact.dateSignedUpToYpp
    )
    let videos_sync_reward_in_usd = latestSyncRewardInUsd({ tier: contact.tier, syncedCount })

    if (contact.yppRewardStatus === 'To Pay') {
      sign_up_reward_in_usd = contact.sign_up_reward_in_usd
      latest_referral_reward_in_usd = contact.latest_referral_reward_in_usd + latest_referral_reward_in_usd
      videos_sync_reward_in_usd = contact.videos_sync_reward_in_usd + videos_sync_reward_in_usd
    }

    const anyRewardOwed = sign_up_reward_in_usd + latest_referral_reward_in_usd + videos_sync_reward_in_usd

    const contactRewardFields: Partial<HubspotYPPContact> = {
      new_synced_vids: syncedCount.toString(),
      latest_ypp_period_wc: new Date().setUTCHours(0, 0, 0, 0).toString(),
      sign_up_reward_in_usd: sign_up_reward_in_usd.toString(),
      latest_referral_reward_in_usd: latest_referral_reward_in_usd.toString(),
      videos_sync_reward: videos_sync_reward_in_usd.toString(),
      latest_ypp_reward_status: anyRewardOwed ? 'To Pay' : 'Paid',
      ...(anyRewardOwed ? {} : { latest_ypp_reward: '0' }),
    }
    await updateYppContact(contact.contactId, contactRewardFields)
  }
}

export async function addNewYppContactsToHubspot() {
  console.log('Adding new YPP contacts to Hubspot...')
  const channels = await getAllVerifiedChannels()
  const existingContacts = await getAllYppContacts(['customer', 'lead'])

  const nonExistentContacts = _.differenceBy(channels, existingContacts, (item) => item.email.toLowerCase()).map(
    (ch) => ({ properties: mapDynamoItemToContactFields(ch) })
  )

  await createYppContacts(nonExistentContacts)
  console.log('Total new contacts count: ', nonExistentContacts.length)
}
