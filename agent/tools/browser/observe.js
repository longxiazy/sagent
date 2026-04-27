import { cleanText } from '../../core/utils.js';

export function summarizeBrowserObservation(observation) {
  return {
    title: observation.title,
    url: observation.url,
    text: cleanText(observation.bodyText, 320),
    elements: Array.isArray(observation.elements) ? observation.elements.slice(0, 8) : [],
  };
}

export async function captureBrowserObservation(page) {
  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
      if (attempt > 0) {
        await new Promise(r => setTimeout(r, 1000));
      }
      return await page.evaluate(() => {
        const isVisible = element => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return (
            style &&
            style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            rect.width > 0 &&
            rect.height > 0
          );
        };

        const getText = element => {
          const directText = [
            element.innerText,
            element.getAttribute('aria-label'),
            element.getAttribute('placeholder'),
            element.getAttribute('title'),
            element.getAttribute('alt'),
            element.getAttribute('value'),
            element.getAttribute('name'),
          ]
            .filter(Boolean)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();

          return directText.slice(0, 160);
        };

        const elements = Array.from(
          document.querySelectorAll(
            'a, button, input, textarea, select, [role="button"], [contenteditable="true"]'
          )
        )
          .filter(isVisible)
          .slice(0, 30)
          .map((element, index) => {
            const elementId = String(index + 1);
            element.setAttribute('data-agent-node-id', elementId);

            return {
              id: elementId,
              tag: element.tagName.toLowerCase(),
              text: getText(element),
              type: element.getAttribute('type') || '',
              href: element.getAttribute('href') || '',
            };
          });

        const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 5000);

        return {
          title: document.title,
          url: window.location.href,
          bodyText,
          elements,
        };
      });
    } catch (err) {
      const msg = err.message || String(err);
      if (/execution context was destroyed|navigation|frame was detached|context.*destroyed/i.test(msg) && attempt < maxRetries) {
        continue;
      }
      return { title: '', url: page.url(), bodyText: '', elements: [] };
    }
  }
}
