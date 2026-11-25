// Token estimates and gateway rate limits. These are methods of Agent (mixed in by src/agent.js),
// so `this` is the agent.

// Errors servers return when the request is larger than the model's context window.
const isContextOverflow = (e) => /^HTTP (400|413|422)\b/.test(e.message || '') &&
  /context[ _-]?(length|window)|maximum context|too many (input )?tokens|exceeds? the (maximum|max|context)|input (is )?too long|prompt is too long|token limit|max_?tokens.*exceed|request too large/i.test(e.message);

class RateLimits {
  /** Estimated tokens for messages, using the characters-per-token ratio measured on this gateway. */
  est(msgs) { return Math.ceil(JSON.stringify(msgs).length / this.charsPerToken); }

  /** Learn the real characters-per-token ratio from a reply's reported prompt size. */
  calibrate(chars, promptTokens) {
    if (!(promptTokens > 500) || !(chars > 0)) return;
    const ratio = Math.min(8, Math.max(1.5, chars / promptTokens));
    this.charsPerToken = this.calibrated ? this.charsPerToken * 0.5 + ratio * 0.5 : ratio;
    this.calibrated = true;
  }


  /**
   * The context size the agent actually works within: the configured window, lowered by a limit
   * learned from a context-overflow error, and kept under the gateway's tokens-per-minute limit
   * (a single request larger than that could never be sent).
   */
  effectiveWindow(cfg) {
    let w = cfg.contextWindow || 1000000;
    if (this.learnedWindow) w = Math.min(w, this.learnedWindow);
    const tpm = this.limits && this.limits.tokensLimit;
    if (tpm > 0 && tpm * 0.9 < w) {
      w = Math.floor(tpm * 0.9);
      if (!this.capNoticeShown) {
        this.capNoticeShown = true;
        this.ui.post({ type: 'info', text: `Using a ${Math.round(w / 1000)}k-token context window to stay under the gateway's ${Math.round(tpm / 1000)}k tokens-per-minute limit.` });
      }
    }
    return w;
  }

  updateLimits(meta) {
    const keys = ['tokensLimit', 'tokensRemaining', 'tokensResetS', 'requestsLimit', 'requestsRemaining', 'requestsResetS', 'creditsLimit', 'creditsRemaining', 'creditsResetS'];
    if (!keys.some((k) => meta[k] !== undefined)) return;
    this.limits = { ...(this.limits || {}), ...meta };
    this.limitsAt = Date.now();
  }

  /**
   * Wait for the per-minute window to reset when the next request would exceed what's left of it,
   * instead of sending it and getting a 429. Uses the most recent rate-limit headers.
   */
  async throttle(estimate) {
    const L = this.limits;
    if (!L) return;
    const elapsed = (Date.now() - this.limitsAt) / 1000;
    let wait = 0, why = '';
    if (L.tokensRemaining !== undefined && L.tokensResetS > elapsed && estimate > L.tokensRemaining && !(L.tokensLimit && estimate > L.tokensLimit)) {
      wait = L.tokensResetS - elapsed; why = 'tokens-per-minute';
    }
    if (L.requestsRemaining !== undefined && L.requestsRemaining <= 0 && L.requestsResetS > elapsed && L.requestsResetS - elapsed > wait) {
      wait = L.requestsResetS - elapsed; why = 'requests-per-minute';
    }
    if (wait <= 0) return;
    wait = Math.min(wait + 0.5, 65);
    this.ui.post({ type: 'info', text: `Waiting ${Math.ceil(wait)}s for the gateway's ${why} limit to reset…` });
    await new Promise((resolve) => {
      const t = setTimeout(resolve, wait * 1000);
      this.abort.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
    });
    if (this.abort.signal.aborted) throw new Error('aborted');
    this.limits = { ...L, tokensRemaining: undefined, requestsRemaining: undefined };   // window reset; wait for fresh headers
  }
}

module.exports = { RateLimits, isContextOverflow };
