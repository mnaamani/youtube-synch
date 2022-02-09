import { DomainError } from "@youtube-sync/domain"

export type JoystreamLibErrorType =
  | 'ApiNotConnectedError'
  | 'UnknownError'
  | 'FailedError'
  | 'SignCancelledError'
  | 'AccountNotSelectedError'
  | 'VoucherLimitError'
  | 'MissingRequiredEventError'

type JoystreamLibErrorArgs = {
  name: JoystreamLibErrorType
  message?: string
  details?: unknown
}

export class JoystreamLibError extends DomainError {
  name: JoystreamLibErrorType
  details: unknown
  constructor({ name, message, details }: JoystreamLibErrorArgs) {
    super(message)
    this.name = name
    this.details = details
  }
}
