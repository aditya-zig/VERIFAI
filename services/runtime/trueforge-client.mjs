function trimSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => {
    if (typeof block === 'string') return block;
    if (typeof block?.text === 'string') return block.text;
    if (typeof block?.content === 'string') return block.content;
    return '';
  }).filter(Boolean).join('\n');
}

function withTimeout(timeoutMs, external) {
  const timeout = AbortSignal.timeout(Math.max(1000, timeoutMs));
  return external ? AbortSignal.any([timeout, external]) : timeout;
}

export class TrueForgeClient {
  constructor({
    baseUrl = 'http://127.0.0.1:8790',
    token,
    timeoutMs = 180000,
    fetchImpl = fetch,
  } = {}) {
    this.baseUrl = trimSlash(baseUrl);
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  headers(accept = 'application/json') {
    return {
      accept,
      'content-type': 'application/json',
      ...(this.token ? {authorization: 'Bearer ' + this.token} : {}),
    };
  }

  url(path) {
    return this.baseUrl + (path.startsWith('/') ? path : '/' + path);
  }

  async health(signal) {
    const response = await this.fetchImpl(this.url('/healthz'), {
      headers: this.headers(),
      signal: withTimeout(Math.min(this.timeoutMs, 15000), signal),
    });
    if (!response.ok) throw new Error('TrueForge health check failed: HTTP ' + response.status);
    return true;
  }

  async createSession(spec, signal) {
    const response = await this.fetchImpl(this.url('/api/v1/sessions'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({agent: {spec}}),
      signal: withTimeout(this.timeoutMs, signal),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error('TrueForge session create failed: HTTP ' + response.status + ' ' + JSON.stringify(body).slice(0, 1500));
    }
    const id = body?.data?.id;
    if (typeof id !== 'string' || !id) throw new Error('TrueForge session response missing data.id');
    return id;
  }

  async cancelSession(sessionId) {
    const response = await this.fetchImpl(this.url('/api/v1/sessions/' + encodeURIComponent(sessionId) + '/cancel'), {
      method: 'POST',
      headers: this.headers(),
      body: '{}',
      signal: withTimeout(Math.min(this.timeoutMs, 15000)),
    });
    if (!response.ok && response.status !== 409) {
      throw new Error('TrueForge session cancel failed: HTTP ' + response.status);
    }
  }

  async runTurn(sessionId, prompt, {signal, timeoutMs = this.timeoutMs, onEvent} = {}) {
    let response;
    try {
      response = await this.fetchImpl(this.url('/api/v1/sessions/' + encodeURIComponent(sessionId) + '/turns'), {
        method: 'POST',
        headers: this.headers('text/event-stream'),
        body: JSON.stringify({
          input: [{type: 'user.message', content: prompt}],
          previous_turn_id: 'none',
          stream: true,
        }),
        signal: withTimeout(timeoutMs, signal),
      });
    } catch (error) {
      if (signal?.aborted) await this.cancelSession(sessionId).catch(() => undefined);
      throw error;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error('TrueForge turn start failed: HTTP ' + response.status + ' ' + body.slice(0, 1500));
    }
    if (!response.body) throw new Error('TrueForge turn response missing SSE body');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let observedTurnId;
    let lastMessage = '';
    const events = [];

    try {
      while (true) {
        const item = await reader.read();
        buffer += decoder.decode(item.value || new Uint8Array(), {stream: !item.done});
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          let event;
          try { event = JSON.parse(trimmed.slice(5).trim()); } catch { continue; }
          events.push(event);
          await onEvent?.(event);
          if (event.type === 'turn.created') observedTurnId = event?.turn?.id || event?.id || observedTurnId;
          if (event.type === 'model.message') {
            const text = textFromContent(event.content);
            if (text.trim()) lastMessage = text;
          }
          if (event.type === 'turn.done') {
            const state = event.state || {};
            return {
              sessionId,
              turnId: event.turn_id || observedTurnId,
              status: state.status || 'done',
              answer: textFromContent(state?.output?.content ?? state?.output) || lastMessage,
              error: state.status === 'error' ? state.message : undefined,
              metrics: state.metrics,
              events,
            };
          }
        }
        if (item.done) break;
      }
    } catch (error) {
      if (signal?.aborted) {
        await this.cancelSession(sessionId).catch(() => undefined);
        throw signal.reason || error;
      }
      throw error;
    } finally {
      reader.releaseLock();
    }

    throw new Error('TrueForge turn ended without terminal event');
  }
}
