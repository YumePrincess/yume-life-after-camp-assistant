// XMLHttpRequest exposes upload byte progress on Safari, Web Clips and browsers.
// Return a normal Response so authentication/error handling stays in api.js.
export function uploadWithProgress(url, options, XMLHttpRequestClass = globalThis.XMLHttpRequest) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequestClass();
    const signal = options.signal;
    const abortError = () => new DOMException('Upload cancelled', 'AbortError');
    if (signal?.aborted) { reject(abortError()); return; }
    const abort = () => xhr.abort();
    const finish = callback => value => {
      signal?.removeEventListener('abort', abort);
      callback(value);
    };
    const fail = finish(reject);
    xhr.upload.onprogress = event => {
      if (event.lengthComputable && event.total > 0) options.onUploadProgress(event.loaded, event.total);
    };
    xhr.open(options.method || 'POST', url);
    if (options.credentials === 'include') xhr.withCredentials = true;
    for (const [key, value] of Object.entries(options.headers || {})) xhr.setRequestHeader(key, value);
    xhr.onload = finish(() => {
      if (!xhr.status) { reject(new TypeError('Upload connection failed')); return; }
      resolve(new Response(xhr.responseText || null, {
        status: xhr.status, statusText: xhr.statusText, headers: new Headers(xhr.getAllResponseHeaders().trim().split(/[\r\n]+/).filter(Boolean).map(line => {
          const index = line.indexOf(':');
          return [line.slice(0, index), line.slice(index + 1).trim()];
        }))
      }));
    });
    xhr.onerror = () => fail(new TypeError('Upload connection failed'));
    xhr.onabort = () => fail(abortError());
    signal?.addEventListener('abort', abort, { once: true });
    xhr.send(options.body);
  });
}
