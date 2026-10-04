import { infrastructureQuestions } from './bank/infrastructure';
import { operationsQuestions } from './bank/operations';
import { routingQuestions } from './bank/routing';
import { securityQuestions } from './bank/security';
import { switchingQuestions } from './bank/switching';
import type { ExamQuestion } from './types';

export * from './types';
export * from './exam';

/** Every practice exam question, written for this project from the topics in the CCNA study notes. */
export const QUESTION_BANK: ExamQuestion[] = [...infrastructureQuestions, ...switchingQuestions, ...routingQuestions, ...securityQuestions, ...operationsQuestions];
