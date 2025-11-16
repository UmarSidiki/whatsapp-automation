/* eslint-disable @typescript-eslint/no-explicit-any */
declare module "../services/session" {
  export function isAuthorized(code: string): Promise<boolean>;
  export function ensureSession(code: string): Promise<any>;
  export function destroySession(code: string): Promise<boolean>;
  export function getSession(code: string): any;
  export function listSessions(): any;
  export function updateAiConfig(code: string, config: any): any;
  export function getAiConfig(code: string): any;
  export function sendBulkMessages(code: string, payload: any): any;
  export function scheduleMessages(code: string, payload: any): any;
  export function getScheduledMessages(code: string): any;
  export function cancelScheduledMessage(code: string, jobId: string): any;
  export function removeScheduledMessage(code: string, jobId: string): any;
  export function shutdownAll(): any;
}

declare module "../middleware/rateLimiters" {
  export const authLimiter: any;
  export const globalLimiter: any;
}

declare module "../controllers/qrController" {
  import type { Request, Response } from 'express';
  export function getQr(req: Request, res: Response): Promise<void>;
}

declare module "../config/env" {
  const env: any;
  export default env;
}

declare module "../config/logger" {
  const logger: any;
  export default logger;
}

declare module "../controllers/authController" {
  import type { Request, Response } from 'express';
  export function startSession(req: Request, res: Response): Promise<void>;
  export function endSession(req: Request, res: Response): Promise<void>;
  export function sessionStatus(req: Request, res: Response): Promise<void>;
  const _default: any;
  export default _default;
}

declare module "../controllers/qrController" {
  import type { Request, Response } from 'express';
  export function getQr(req: Request, res: Response): any;
  const _default: any;
  export default _default;
}

declare module "../controllers/healthController" {
  import type { Request, Response } from 'express';
  export function getHealth(req: Request, res: Response): any;
  const _default: any;
  export default _default;
}

declare module "../controllers/aiController" {
  import type { Request, Response } from 'express';
  export function configureAi(req: Request, res: Response): any;
  export function getAiConfig(req: Request, res: Response): any;
  export function updateCustomReplies(req: Request, res: Response): any;
  const _default: any;
  export default _default;
}

declare module "../controllers/messageController" {
  import type { Request, Response } from 'express';
  export function handleBulkSend(req: Request, res: Response): any;
  export function listScheduled(req: Request, res: Response): any;
  export function createSchedule(req: Request, res: Response): any;
  export function cancelSchedule(req: Request, res: Response): any;
  const _default: any;
  export default _default;
}

declare module "emoji-regex" {
  function emojiRegex(): RegExp;
  export default emojiRegex;
}

/* eslint-enable @typescript-eslint/no-explicit-any */
