// Other people's writing is untrusted input. These two functions are the only ways it may
// reach a page as HTML. Both are plain globals so the older single-file pages can use them.
(function () {
  var entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  // Safe in text and in quoted attributes.
  window.routerEscapeHtml = function (value) {
    return String(value === undefined || value === null ? '' : value).replace(/[&<>"']/g, function (c) { return entities[c]; });
  };

  // Only ordinary web and mail links may become clickable.
  window.routerSafeLink = function (value) {
    return typeof value === 'string' && /^(https?:\/\/|mailto:)[^\s"'<>]+$/i.test(value) ? value : null;
  };

  var configured = false;
  // Markdown for long notes. Without both local libraries it falls back to plain text:
  // a note that looks worse is better than one that can run code in the reader's browser.
  window.routerMarkdown = function (text) {
    var source = String(text === undefined || text === null ? '' : text);
    if (!window.marked || !window.DOMPurify || !window.DOMPurify.isSupported) return window.routerEscapeHtml(source);
    if (!configured) {
      window.DOMPurify.addHook('afterSanitizeAttributes', function (node) {
        if (node.tagName === 'A' && node.hasAttribute('href')) {
          node.setAttribute('target', '_blank');
          node.setAttribute('rel', 'noopener noreferrer nofollow');
        }
      });
      configured = true;
    }
    return window.DOMPurify.sanitize(window.marked.parse(source), {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'option', 'iframe', 'video', 'audio', 'dialog'],
      FORBID_ATTR: ['style', 'srcset'],
    });
  };
})();
