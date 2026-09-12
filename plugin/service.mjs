import { Service } from '@deepseek-ai/cordis';
import { HarnessError } from '@deepseek-ai/dsh-llm';

export const OPERATIONS = Object.freeze(['sources', 'courses', 'catalog', 'refresh', 'status', 'read', 'import_local']);

export class StudyError extends HarnessError {
  constructor(message, code = 'STUDY_ERROR') {
    super(message, code);
    this.name = 'StudyError';
    this.code = code;
  }
}

/** Service Definition: one replaceable material-input provider, no storage implementation. */
export default class StudyService extends Service {
  providers = new Map();

  constructor(ctx) { super(ctx, 'study'); }

  registerProvider(provider) {
    if (this.providers.has(provider.id)) throw new StudyError('Duplicate study provider', 'STUDY_DUPLICATE_PROVIDER');
    return this.ctx.effect(function* () {
      this.providers.set(provider.id, provider);
      yield () => this.providers.delete(provider.id);
    }.bind(this), 'study.registerProvider()');
  }

  providerIds() { return [...this.providers.keys()]; }

  async call(operation, args, signal) {
    signal.throwIfAborted();
    if (!OPERATIONS.includes(operation)) throw new StudyError('Unknown study operation', 'STUDY_UNKNOWN_OPERATION');
    if (this.providers.size !== 1) throw new StudyError('Exactly one study provider must be active', 'STUDY_PROVIDER_UNAVAILABLE');
    return [...this.providers.values()][0].call(operation, args, signal);
  }
}
