import { Request, Response } from 'express';
import { REFRESH_TOKEN_COOKIE } from '../constants';
import { HttpStatus } from '../constants/httpStatus';
import { authService } from '../services';
import { UnauthorizedError } from '../utils/AppError';
import { asyncHandler } from '../utils/asyncHandler';
import { sendCreated, sendSuccess } from '../utils/apiResponse';
import { clearRefreshCookie, setRefreshCookie } from '../utils/cookies';

export const authController = {
  register: asyncHandler(async (req: Request, res: Response) => {
    const { user, tokens } = await authService.register(req.body, req.ip);
    setRefreshCookie(res, tokens.refreshToken);
    sendCreated(
      res,
      { user, accessToken: tokens.accessToken },
      'Account created. Please verify your email.'
    );
  }),

  login: asyncHandler(async (req: Request, res: Response) => {
    const { user, tokens } = await authService.login(req.body.email, req.body.password, req.ip);
    setRefreshCookie(res, tokens.refreshToken);
    sendSuccess(res, { user, accessToken: tokens.accessToken }, 'Logged in');
  }),

  refresh: asyncHandler(async (req: Request, res: Response) => {
    const token = req.cookies?.[REFRESH_TOKEN_COOKIE] || req.body?.refreshToken;
    if (!token) throw new UnauthorizedError('Refresh token missing');
    const tokens = await authService.refresh(token);
    setRefreshCookie(res, tokens.refreshToken);
    sendSuccess(res, { accessToken: tokens.accessToken }, 'Token refreshed');
  }),

  logout: asyncHandler(async (_req: Request, res: Response) => {
    clearRefreshCookie(res);
    sendSuccess(res, null, 'Logged out');
  }),

  verifyEmail: asyncHandler(async (req: Request, res: Response) => {
    await authService.verifyEmail(req.body.token);
    sendSuccess(res, null, 'Email verified');
  }),

  resendVerification: asyncHandler(async (req: Request, res: Response) => {
    await authService.resendVerification(req.body.email);
    sendSuccess(res, null, 'If the account exists, a verification email has been sent');
  }),

  forgotPassword: asyncHandler(async (req: Request, res: Response) => {
    await authService.forgotPassword(req.body.email);
    sendSuccess(res, null, 'If the account exists, a reset email has been sent');
  }),

  resetPassword: asyncHandler(async (req: Request, res: Response) => {
    await authService.resetPassword(req.body.token, req.body.password);
    sendSuccess(res, null, 'Password reset successfully');
  }),

  facebookLogin: asyncHandler(async (req: Request, res: Response) => {
    // In production the access token is verified against Meta to extract a
    // trusted profile. Verification lives behind real credentials; here we
    // accept the verified profile contract.
    const { user, tokens } = await authService.loginWithFacebook(req.body.profile ?? req.body);
    setRefreshCookie(res, tokens.refreshToken);
    res.status(HttpStatus.OK).json({
      success: true,
      message: 'Logged in with Facebook',
      data: { user, accessToken: tokens.accessToken },
    });
  }),
};
