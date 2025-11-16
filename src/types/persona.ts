export const USER_MESSAGE_PREFIX = "User: ";
export const HUMAN_REPLY_PREFIX = "My reply: ";
export const AI_REPLY_PREFIX = "AI reply: ";

export type PersonaSource = "contact" | "universal" | "bootstrap";

export interface PersonaExample {
  user?: string;
  reply: string;
}

export interface PersonaProfile {
  source: PersonaSource;
  summary: string;
  guidelines: string[];
  examples: PersonaExample[];
}
