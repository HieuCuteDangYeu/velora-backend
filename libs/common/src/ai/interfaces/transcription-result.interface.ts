export interface TranscriptSegment {
  id?: number;
  start: number;
  end: number;
  text: string;
  detectedLanguage?: string;
  [key: string]: unknown;
}

export interface TranscriptionResult {
  text: string;
  detectedLanguage?: string;
  vtt?: string;
  segments?: TranscriptSegment[];
  wordCount?: number;
  provider?: string;
  model?: string;
  version?: string;
}
