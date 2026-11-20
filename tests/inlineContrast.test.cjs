const { test } = require('node:test');
const assert = require('node:assert/strict');
const { relativeLuminance, contrastRatio } = require('../dist/accessibility/inlineContrast.js');
const { scanAccessibility, scanAccessibilityOutcome } = require('../dist/accessibility/scanner.js');

const uri = 'file:///demo/contrast.html';
const ruleId = 'inline-text-contrast';
const paragraph = (style, text = 'Your request has been received.') => `<p style="${style}">${text}</p>`;
const lowContrast = paragraph('color:#aaa; background-color:#fff');

test('WCAG luminance and contrast ratio for opaque sRGB hex', () => {
  assert.equal(relativeLuminance('#000'), 0);
  assert.equal(relativeLuminance('#ffffff'), 1);
  assert.equal(relativeLuminance('#f00'), 0.2126);
  assert.equal(relativeLuminance('#0a0a0a'), 10 / 255 / 12.92);
  assert.equal(contrastRatio('#000', '#fff'), 21);
  assert.equal(contrastRatio('#FFFFFF', '#000000'), 21);
  assert.equal(contrastRatio('#fea', '#ffeeaa'), 1);
  assert.equal(contrastRatio('#aaa', '#ffffff'), contrastRatio('#fff', '#aaaaaa'));
  assert.ok(Math.abs(contrastRatio('#aaaaaa', '#ffffff') - 2.32) < 0.005);
  assert.ok(Math.abs(contrastRatio('#767676', '#ffffff') - 4.54) < 0.005);
  assert.equal(contrastRatio('#aaaa', '#fff'), undefined);
});

test('reports a warning with both colours, the measured ratio, and WCAG review guidance', () => {
  const source = "<P STYLE = ' BACKGROUND-COLOR : #ffffff ; \t CoLoR : #AAA ; '> Notice </P>";
  const [issue, extra] = scanAccessibility(source, uri);
  assert.equal(extra, undefined);
  assert.equal(issue.ruleId, ruleId);
  assert.equal(issue.severity, 'warning');
  assert.deepEqual(issue.wcagCriteria, ['1.4.3']);
  assert.match(issue.message, /foreground #AAA on background #ffffff measures 2\.32:1/);
  assert.match(issue.message, /rendered colours.*4\.5:1.*3:1/);
  assert.equal(source.slice(issue.range.startCharacter, issue.range.endCharacter), '#AAA');
});

test('compares the unrounded ratio with the conservative 3:1 threshold', () => {
  const [close] = scanAccessibility(paragraph('color:#959595; background-color:#fff'), uri);
  assert.equal(contrastRatio('#959595', '#fff').toFixed(2), '3.00');
  assert.equal(close.ruleId, ruleId);
  for (const colour of ['#949494', '#767676', '#000']) {
    assert.deepEqual(scanAccessibility(paragraph(`color:${colour}; background-color:#fff`), uri), []);
  }
});

for (const style of [
  'color:#aaa',
  'background-color:#fff',
  'color:#aaa; COLOR:#bbb; background-color:#fff',
  'color:#aaa; background-color:#fff; background-color:#111',
  'color:#aaa; color:var(--text); background-color:#fff',
  'color:var(--text); background-color:#fff',
  'color:inherit; background-color:#fff',
  'color:black; background-color:#fff',
  'color:#aaa8; background-color:#fff',
  'color:#aaaaaa80; background-color:#fff',
  'color:#aaa; background:#fff',
  'color:#aaa; background-color:#fff; background-image:linear-gradient(#fff,#000)',
  'color:#aaa; background-color:transparent',
  'color:#aaa!important; background-color:#fff',
  'color:#aaa; background-color:#fff; opacity:.5',
  'color:#aaa; /* comment */ background-color:#fff',
  'color:&#35;aaa; background-color:#fff',
]) {
  test(`skips unsupported inline declarations and still scans structural issues (${style})`, () => {
    const result = scanAccessibilityOutcome(paragraph(style) + '<img>', uri);
    assert.equal(result.status, 'analyzed');
    assert.deepEqual(result.issues.map(issue => issue.ruleId), ['image-text-alternative']);
  });
}

test('requires quoted attributes and visible paragraphs with ordinary direct text', () => {
  const excluded = [
    '<p style=color:#aaa;background-color:#fff>Text</p>',
    '<div style="color:#aaa; background-color:#fff">Text</div>',
    paragraph('color:#aaa; background-color:#fff', ' \t '),
    paragraph('color:#aaa; background-color:#fff', 'Prefix <em>nested text</em>'),
    '<div hidden>' + lowContrast + '</div>',
    '<div style="opacity:.5">' + lowContrast + '</div>',
    '<template>' + lowContrast + '</template>',
    '<link rel="alternate StyleSheet" href="/site.css">' + lowContrast,
  ];
  for (const source of excluded) {
    assert.deepEqual(scanAccessibility(source, uri), [], source);
  }
  assert.deepEqual(scanAccessibility(lowContrast, 'file:///demo/contrast.cshtml'), []);
  assert.deepEqual(scanAccessibility(lowContrast, 'file:///demo/contrast.cshtml?name=contrast.html'), []);
  assert.equal(scanAccessibility(lowContrast, 'file:///demo/contrast.HTML?version=1').length, 1);
});

test('foreground ranges and occurrence IDs preserve UTF-16 coordinates with repeated elements and newlines', () => {
  for (const newline of ['\r\n', '\r', '\n']) {
    const lines = [
      '😀 <p title="😀" style="color:#aaa; background-color:#fff">First.</p>',
      '<p style="background-color:#fff;',
      '  color: #aaa">Second.</p>',
    ];
    const source = lines.join(newline);
    const findings = scanAccessibility(source, uri);
    assert.equal(findings.length, 2);
    assert.deepEqual(findings, scanAccessibility(source, uri));
    assert.equal(new Set(findings.map(issue => issue.id)).size, 2);
    const firstColumn = lines[0].indexOf('#aaa');
    const secondColumn = lines[2].indexOf('#aaa');
    assert.deepEqual(findings.map(issue => issue.range), [
      { startLine: 0, startCharacter: firstColumn, endLine: 0, endCharacter: firstColumn + 4 },
      { startLine: 2, startCharacter: secondColumn, endLine: 2, endCharacter: secondColumn + 4 },
    ]);
    for (const [index, offset] of [source.indexOf('#aaa'), source.lastIndexOf('#aaa')].entries()) {
      assert.deepEqual(JSON.parse(findings[index].id), [uri, ruleId, offset, offset + 4]);
    }
  }
});

test('HTML CSS at-rules allow structural scanning, with stylesheets outside contrast and Razor scope', () => {
  const source = '<style>@media print { p { color: black } }</style>' + lowContrast + '<img>';
  const html = scanAccessibilityOutcome(source, uri);
  assert.equal(html.status, 'analyzed');
  assert.deepEqual(html.issues.map(issue => issue.ruleId), ['image-text-alternative']);
  const razor = scanAccessibilityOutcome(source, 'file:///demo/contrast.cshtml');
  assert.equal(razor.status, 'skipped');
  assert.match(razor.reason, /Unsupported Razor/);
});
