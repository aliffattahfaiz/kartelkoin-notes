'use strict';

// Minimal fake of the GitHub Contents API so the handler can be exercised
// end-to-end with no network and no writes to the real notes file.
function createGitHubStub(initialNotes) {
  const state = {
    notes: JSON.parse(JSON.stringify(initialNotes)),
    sha: 'sha-0',
    commits: [],
    puts: 0,
    // Optional hook to simulate a concurrent writer: called before a PUT is
    // accepted, can mutate state and return a 409 once.
    conflictOnce: false,
  };

  function jsonResponse(status, payload) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  }

  async function fetchStub(url, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const body = options.body ? JSON.parse(options.body) : null;

    if (method === 'GET') {
      return jsonResponse(200, {
        content: Buffer.from(JSON.stringify(state.notes, null, 2)).toString('base64'),
        sha: state.sha,
      });
    }

    if (method === 'PUT') {
      state.puts += 1;
      if (state.conflictOnce) {
        state.conflictOnce = false;
        state.sha = 'sha-concurrent';
        return jsonResponse(409, { message: 'sha does not match' });
      }
      if (body.sha !== state.sha) {
        return jsonResponse(409, { message: 'sha does not match' });
      }
      state.notes = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'));
      state.sha = `sha-${state.puts}`;
      state.commits.push(body.message);
      return jsonResponse(200, { content: { sha: state.sha } });
    }

    return jsonResponse(405, { message: 'unsupported' });
  }

  return { state, fetchStub };
}

function createRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    finished: false,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      this.finished = true;
      return this;
    },
    end() {
      this.finished = true;
      return this;
    },
  };
  return res;
}

function createReq(method, body, headers = {}) {
  return {
    method,
    body,
    headers: { 'content-type': 'application/json', ...headers },
  };
}

module.exports = { createGitHubStub, createRes, createReq };
