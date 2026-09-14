import { formatProcessingError } from './format-processing-error';

describe('formatProcessingError', () => {
  it('includes process stderr in the diagnostic message', () => {
    const error = Object.assign(new Error('ffmpeg exited with code 1'), {
      stderr: '[Parsed_lowpass_1] Invalid frequency and/or width!',
    });

    expect(formatProcessingError(error).message).toBe(
      'ffmpeg exited with code 1\n' +
        'process stderr:\n' +
        '[Parsed_lowpass_1] Invalid frequency and/or width!',
    );
  });
});
