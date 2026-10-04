import { describe, expect, it } from 'vitest';
import {
  canTransitionSupportTicket,
  shouldRequestCustomerRating,
  statusAfterCustomerMessage,
  validateSupportTicketTransition,
} from '../support/domain';

describe('support ticket domain', () => {
  it('reopens a paused or finished ticket after a customer message', () => {
    expect(statusAfterCustomerMessage('waiting')).toBe('reopened');
    expect(statusAfterCustomerMessage('on_hold')).toBe('reopened');
    expect(statusAfterCustomerMessage('resolved')).toBe('reopened');
    expect(statusAfterCustomerMessage('closed')).toBe('reopened');
    expect(statusAfterCustomerMessage('open')).toBe('open');
  });

  it('requires a public support reply before resolution', () => {
    expect(validateSupportTicketTransition('open', 'resolved')).toContain('публичный ответ');
    expect(validateSupportTicketTransition('open', 'resolved', { hasPublicSupportReply: true })).toBeNull();
  });

  it('requires a public message when waiting for the customer', () => {
    expect(validateSupportTicketTransition('open', 'waiting')).toContain('сообщением клиенту');
    expect(validateSupportTicketTransition('open', 'waiting', { hasPublicMessageForWaiting: true })).toBeNull();
  });

  it('keeps duplicate and spam terminal', () => {
    expect(canTransitionSupportTicket('duplicate', 'open')).toBe(false);
    expect(canTransitionSupportTicket('spam', 'open')).toBe(false);
  });

  it('requests CSAT only after resolution', () => {
    expect(shouldRequestCustomerRating('resolved')).toBe(true);
    expect(shouldRequestCustomerRating('closed')).toBe(false);
  });
});
