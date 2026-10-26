import type {
  CharacterReply,
  DialogueContext,
  Emotion,
} from "../../shared/contracts";

export interface AudioInput {
  bytes: Buffer;
  mimeType: string;
  filename: string;
}

export interface AudioBytes {
  bytes: Buffer;
  mimeType: "audio/wav" | "audio/mpeg";
}

export interface DialogueProvider {
  transcribe(input: AudioInput, signal: AbortSignal): Promise<string>;
  generateReply(
    input: DialogueContext,
    signal: AbortSignal,
  ): Promise<CharacterReply>;
  synthesize(
    text: string,
    signal: AbortSignal,
    emotion?: Emotion,
  ): Promise<AudioBytes>;
}
