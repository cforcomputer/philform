// Phil, Philform's mascot. Drawn by tools/make-icons.py: change it there and
// rerun the script, not here.

const BODY = '<path d="M20 42.9L27.5 37L80 37L80 80.1L72.5 86L20 86Z" fill="#25282f" stroke="#25282f" stroke-width="24" stroke-linejoin="round"/><path d="M80 39.9L86 35.2L86 83.1L80 87.8Z" fill="#e1e7ec" stroke="#e1e7ec" stroke-width="4" stroke-linejoin="round"/><path d="M21.6 34L25.4 31L78.4 31L74.6 34Z" fill="#ffffff" stroke="#ffffff" stroke-width="4" stroke-linejoin="round"/><ellipse cx="31" cy="31" rx="11.5" ry="11.5" fill="#25282f"/><ellipse cx="31" cy="31" rx="7.5" ry="7.5" fill="#ffffff"/><ellipse cx="31" cy="33" rx="4.8" ry="4.8" fill="#ffa0ba"/><ellipse cx="63" cy="31" rx="11.5" ry="11.5" fill="#25282f"/><ellipse cx="63" cy="31" rx="7.5" ry="7.5" fill="#ffffff"/><ellipse cx="63" cy="33" rx="4.8" ry="4.8" fill="#ffa0ba"/><path d="M19 47L67 47L67 87L19 87Z" fill="#25282f" stroke="#25282f" stroke-width="22" stroke-linejoin="round"/><path d="M19 47L67 47L67 87L19 87Z" fill="#fffbf5" stroke="#fffbf5" stroke-width="14" stroke-linejoin="round"/><ellipse cx="60" cy="11.5" rx="12.5" ry="12.5" fill="#06c755" fill-opacity="0.3" class="phil-glow"/><path d="M50 30L49.3 26.9L48.8 23.9L48.5 21.2L48.2 18.7L48.2 16.4L48.3 14.3L48.6 12.4L49 10.8L49.6 9.3L50.3 8L51.2 7L52.2 6.2L53.5 5.6L54.8 5.2L56.3 5L58 5" fill="none" stroke="#25282f" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" class="phil-stalk"/><ellipse cx="60" cy="11.5" rx="9" ry="9" fill="#25282f"/><ellipse cx="60" cy="11.5" rx="7" ry="7" fill="#04a246" class="phil-bulb"/><ellipse cx="60" cy="11.5" rx="5.5" ry="5.5" fill="#06c755" class="phil-bulb"/><path d="M56.6 11.8L59.1 14.2L63.6 8.9" fill="none" stroke="#ffffff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="phil-tick"/><ellipse cx="21" cy="70" rx="5.5" ry="3.2" fill="#ffb6c6"/><ellipse cx="65" cy="70" rx="5.5" ry="3.2" fill="#ffb6c6"/><path d="M37 69L37.1 69.9L37.6 70.8L38.2 71.4L39.1 71.9L40 72L40.9 71.9L41.8 71.4L42.4 70.8L42.9 69.9L43 69L43.1 69.9L43.6 70.8L44.2 71.4L45.1 71.9L46 72L46.9 71.9L47.8 71.4L48.4 70.8L48.9 69.9L49 69" fill="none" stroke="#25282f" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>';
const EYES = '<g class="phil-eyes"><ellipse cx="30.5" cy="62" rx="4.7" ry="5.8" fill="#25282f"/><ellipse cx="29.1" cy="59.9" rx="1.7" ry="1.7" fill="#ffffff"/><ellipse cx="55.5" cy="62" rx="4.7" ry="5.8" fill="#25282f"/><ellipse cx="54.1" cy="59.9" rx="1.7" ry="1.7" fill="#ffffff"/></g>';
const HAPPY = '<g class="phil-eyes"><path d="M26.2 62.6L26.5 61.9L27 61.2L27.5 60.7L28.2 60.2L28.9 59.9L29.7 59.7L30.5 59.6L31.3 59.7L32.1 59.9L32.8 60.2L33.5 60.7L34 61.2L34.5 61.9L34.8 62.6" fill="none" stroke="#25282f" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><path d="M51.2 62.6L51.5 61.9L52 61.2L52.5 60.7L53.2 60.2L53.9 59.9L54.7 59.7L55.5 59.6L56.3 59.7L57.1 59.9L57.8 60.2L58.5 60.7L59 61.2L59.5 61.9L59.8 62.6" fill="none" stroke="#25282f" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></g>';
const FEET = '<g class="phil-feet"><g class="phil-foot phil-foot-l"><ellipse cx="22" cy="97.5" rx="9.5" ry="6.8" fill="#25282f"/><ellipse cx="22" cy="97.5" rx="5.5" ry="2.8" fill="#fffbf5"/></g><g class="phil-foot phil-foot-r"><ellipse cx="64" cy="97.5" rx="9.5" ry="6.8" fill="#25282f"/><ellipse cx="64" cy="97.5" rx="5.5" ry="2.8" fill="#fffbf5"/></g></g>';

/** Phil as SVG markup. mood "calm" or "happy"; running makes the feet run. */
export function philSvg({ mood = 'calm', running = false } = {}) {
  return `<svg class="phil phil-${mood}${running ? ' phil-running' : ''}" viewBox="-2 0 104 104" aria-hidden="true">` +
    `<g class="phil-body">${BODY}${mood === 'happy' ? HAPPY : EYES}</g>${FEET}</svg>`;
}

/** Draw Phil into every element marked data-phil="calm", "happy" or "running". */
export function drawPhils(root = document) {
  for (const el of root.querySelectorAll('[data-phil]')) {
    const kind = el.dataset.phil;
    el.innerHTML = philSvg({ mood: kind === 'happy' ? 'happy' : 'calm', running: kind === 'running' });
  }
}
