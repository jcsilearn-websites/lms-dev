// LAZY chunk: TypeBox value checker + the contract schemas. Loaded on the first focus of a public
// form field (see shared/forms/useSimpleForm.ts); never import this file from eagerly loaded code.
import {
  AcceptInviteRequestSchema,
  ForgotPasswordRequestSchema,
  LoginRequestSchema,
  ResetPasswordRequestSchema,
} from '@lms/backend/contracts';
import { validate } from '../../shared/forms/validation';

export const validateLogin = (v: Record<string, string>) => validate(LoginRequestSchema, v);
export const validateForgot = (v: Record<string, string>) =>
  validate(ForgotPasswordRequestSchema, v);
export const validateReset = (v: Record<string, string>) => validate(ResetPasswordRequestSchema, v);
export const validateAccept = (v: Record<string, string>) => {
  // the password is optional for people who already have an account
  const { password, ...rest } = v;
  return validate(AcceptInviteRequestSchema, password ? v : rest);
};
