export class InvalidMediaFileError extends Error {
  constructor(
    message = 'The uploaded reel video file does not exist in storage.',
  ) {
    super(message);
    this.name = 'InvalidMediaFileError';
  }
}

export class ReelPublishIntentConflictError extends Error {
  constructor(
    message = 'This publish intent was already used with a different reel payload.',
  ) {
    super(message);
    this.name = 'ReelPublishIntentConflictError';
  }
}

export class ReelUploadLeaseUnavailableError extends Error {
  constructor(
    message = 'The Reel upload lease is no longer active; upload it again.',
  ) {
    super(message);
    this.name = 'ReelUploadLeaseUnavailableError';
  }
}

export class ReelUploadLeaseExpiredError extends Error {
  constructor() {
    super(
      'This abandoned Reel upload expired. Cancel the saved publish and publish again.',
    );
    this.name = 'ReelUploadLeaseExpiredError';
  }
}

export class ReelNotFoundError extends Error {
  constructor() {
    super('Reel not found.');
    this.name = 'ReelNotFoundError';
  }
}

export class ReelNotReadyError extends Error {
  constructor() {
    super('Reel is not ready to be shared.');
    this.name = 'ReelNotReadyError';
  }
}

export class ReelShareForbiddenError extends Error {
  constructor(message = 'You are not allowed to share this reel.') {
    super(message);
    this.name = 'ReelShareForbiddenError';
  }
}

export class ReelReprocessForbiddenError extends Error {
  constructor(message = 'You are not allowed to reprocess this reel.') {
    super(message);
    this.name = 'ReelReprocessForbiddenError';
  }
}

export class ReelAlreadyProcessingError extends Error {
  constructor(message = 'This reel is already being processed.') {
    super(message);
    this.name = 'ReelAlreadyProcessingError';
  }
}

export class ReelShareLinkNotFoundError extends Error {
  constructor() {
    super('Reel share link not found.');
    this.name = 'ReelShareLinkNotFoundError';
  }
}

export class ReelShareLinkExpiredError extends Error {
  constructor() {
    super('Reel share link has expired.');
    this.name = 'ReelShareLinkExpiredError';
  }
}

export class ReelShareLinkRevokedError extends Error {
  constructor() {
    super('Reel share link has been revoked.');
    this.name = 'ReelShareLinkRevokedError';
  }
}

export class ReelSeriesNotFoundError extends Error {
  constructor() {
    super('Reel series not found.');
    this.name = 'ReelSeriesNotFoundError';
  }
}

export class ReelSeriesForbiddenError extends Error {
  constructor(message = 'You are not allowed to modify this reel series.') {
    super(message);
    this.name = 'ReelSeriesForbiddenError';
  }
}

export class ReelSeriesConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReelSeriesConflictError';
  }
}
