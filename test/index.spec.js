import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src';

describe('The Warden worker', () => {
	it('returns Invalid JSON for unsupported content type (unit style)', async () => {
		const request = new Request('http://example.com');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(400);
		expect(await response.text()).toBe('Invalid JSON');
	});

	it('handles Slack url_verification (integration style)', async () => {
		const response = await SELF.fetch('http://example.com', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ type: 'url_verification', challenge: 'abc123' }),
		});

		expect(response.status).toBe(200);
		expect(await response.text()).toBe('abc123');
	});

	it('rejects unauthorized message_action without calling Slack APIs', async () => {
		const request = new Request('http://example.com', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				type: 'message_action',
				callback_id: 'warden_type_shortcut',
				user: { id: 'U_NOT_WARDEN' },
			}),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('');
	});
});
