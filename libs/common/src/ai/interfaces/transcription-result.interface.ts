export interface TranscriptSegment {
  id?: number;
  start: number;
  end: number;
  text: string;
  textEn?: string;
  textVi?: string;
  originalText?: string;
  detectedLanguage?: string;
  [key: string]: unknown;
}

export interface TranscriptionResult {
  text: string;
  textEn?: string;
  textVi?: string;
  detectedLanguage?: string;
  vtt?: string;
  segments?: TranscriptSegment[];
  wordCount?: number;
  provider?: string;
  model?: string;
  version?: string;
}

