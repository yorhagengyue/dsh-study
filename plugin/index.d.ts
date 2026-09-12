import { Context, Service } from '@deepseek-ai/cordis';
export type StudyOperation = 'sources' | 'courses' | 'catalog' | 'refresh' | 'status' | 'read' | 'import_local';
export interface StudyProvider {
  id: string;
  call(operation: StudyOperation, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}
export default class StudyService extends Service {
  constructor(ctx: Context);
  registerProvider(provider: StudyProvider): () => void;
  providerIds(): string[];
  call(operation: StudyOperation, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}
declare module '@deepseek-ai/cordis' { interface Context { study: StudyService; } }
