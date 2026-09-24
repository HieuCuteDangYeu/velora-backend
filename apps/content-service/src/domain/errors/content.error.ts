export class InvalidMediaFileError extends Error {
  constructor(message = 'The uploaded reel video file does not exist in storage.') {
    super(message);
    this.name = 'InvalidMediaFileError';
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
