const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scanAccessibility } = require('../dist/accessibility/scanner.js');
const { getRule } = require('../dist/accessibility/rules.js');
const { maskRazorDirectives } = require('../dist/accessibility/razor.js');
const uri = 'file:///demo/view.cshtml';
const scan = (source) => scanAccessibility(source, uri);

test('missing alternative produces one complete finding from catalog metadata', () => {
  const source = '<img src="logo.png">';
  const [issue] = scan(source);
  const rule = getRule('image-text-alternative');
  assert.equal(scan(source).length, 1);
  assert.deepEqual(issue, {
    id: JSON.stringify([uri, rule.id, 0, source.length]),
    ruleId: rule.id, title: rule.title,
    message: 'Image has no recognized text alternative. ' + rule.remediation,
    fileUri: uri,
    range: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: source.length },
    category: rule.category, severity: rule.severity, wcagCriteria: rule.wcagCriteria,
  });
});

for (const source of [
  '<img src="logo.png" alt="Ontario logo">',
  '<img src="divider.png" alt="">',
  '<img alt>',
  '<img src="logo.png" aria-label="Ontario logo">',
  '<span id="name">Logo</span><img aria-labelledby="name">',
  '<img aria-labelledby="runtime-reference">',
  '<img title="Ontario logo">',
  '<IMG ALT="Ontario logo" SRC="logo.png" />',
  '<img src="@Model.ImageUrl"\n     alt="@Model.ImageDescription">',
  "<img alt='@Model.ImageDescription'>",
  '<img aria-label="@Model.ImageDescription">',
]) {
  test(`recognizes alternative: ${source}`, () => assert.deepEqual(scan(source), []));
}

test('empty ARIA attributes do not supply a name', () => {
  assert.equal(scan('<img aria-label="  " aria-labelledby="">').length, 1);
});

test('a dynamic src alone does not provide alternative text', () => {
  assert.equal(scan('<img src="@Model.ImageUrl">').length, 1);
});

test('multiline tag ranges are zero-based and end-exclusive for LF, CRLF and CR', () => {
  for (const newline of ['\n', '\r\n', '\r']) {
    const [issue] = scan(`text${newline}  <img${newline} src="x">`);
    assert.deepEqual(issue.range, {
      startLine: 1, startCharacter: 2, endLine: 2, endCharacter: 9,
    });
  }
});

test('columns count UTF-16 code units, including emoji', () => {
  assert.deepEqual(scan('😀<img>')[0].range, {
    startLine: 0, startCharacter: 2, endLine: 0, endCharacter: 7,
  });
});

test('multiple findings are ordered, unique, deterministic and file-specific', () => {
  const source = '<img>\n<div><img src="b"></div><img alt="">';
  const findings = scan(source);
  assert.equal(findings.length, 2);
  assert.equal(new Set(findings.map((issue) => issue.id)).size, 2);
  assert.deepEqual(scan(source), findings);
  assert.notEqual(scanAccessibility(source, 'file:///other.html')[0].id, findings[0].id);
  assert.equal(findings[0].range.startLine, 0);
  assert.equal(findings[1].range.startLine, 1);
});

test('comments, scripts, styles and inert templates do not generate findings', () => {
  assert.deepEqual(scan(`<!-- <img> -->
    <script>const markup = '<img>';</script>
    <style>/* <img> */</style><template><img></template>`), []);
});

test('explicit hidden/decorative and server-processed elements are skipped', () => {
  for (const source of [
    '<img hidden>', '<div hidden><img></div>', '<img aria-hidden="true">',
    '<section aria-hidden="true"><img></section>',
    '<img role="presentation">', '<img role="none">',
    '<img asp-src-include="images/*">', '<img runat="server">',
    '<div runat="server"><img></div>',
  ]) assert.deepEqual(scan(source), [], source);
});

test('unsupported Razor skips the whole source instead of scanning C# as HTML', () => {
  for (const source of [
    '@Html.TextBoxFor(m => m.Name)',
    '@* <img> *@', '@{ var html = "<img>"; }',
    '<img @Model.Attributes>', '<img src="@(GetUrl())">',
    '<img src="@Url.Content("~/logo.png")">',
    '@if (Model.Show) { <img> }', '<img><img alt="@GetText()">',
    '<img src="prefix/@Model.ImageUrl">',
  ]) assert.deepEqual(scan(source), [], source);
});

test('malformed input is safe and does not report speculative findings', () => {
  for (const source of ['<img', '<img alt="', '<img src="x" src="y">', '<img <div>']) {
    assert.deepEqual(scan(source), [], source);
  }
  // Ordinary optional/missing container end tags can still be parsed safely.
  assert.equal(scan('<div><img>').length, 1);
});

test('empty source and pages without supported controls have no findings', () => {
  assert.deepEqual(scan(''), []);
  assert.deepEqual(scan('<p>Content</p>'), []);
});

for (const directive of [
  '@model ProductViewModel', '@model MyApp.Models.ProductViewModel',
  '@using MyApp.Models', '@using MyApp.Models;',
  '@inherits MyApp.BaseView', '@namespace MyApp.Views',
]) {
  test(`scans images after header directive: ${directive}`, () => {
    assert.equal(scan(`${directive}\n<img>`).length, 1);
    assert.deepEqual(scan(`${directive}\n<img alt="@Model.Description">`), []);
  });
}

test('masking preserves source length, line endings, image ranges and occurrence offsets', () => {
  for (const newline of ['\n', '\r\n', '\r']) {
    const lines = ['\uFEFF\t@model MyApp.Product', '', '  @using MyApp.Models', '  <img', ' src="@Model.ImageUrl">'];
    const source = lines.join(newline);
    const prepared = maskRazorDirectives(source);
    assert.equal(prepared.length, source.length);
    assert.equal(prepared, [
      ' '.repeat(lines[0].length), '', ' '.repeat(lines[2].length), lines[3], lines[4],
    ].join(newline));
    const [issue] = scan(source);
    assert.equal(scan(source).length, 1);
    assert.deepEqual(issue.range, {
      startLine: 3, startCharacter: 2, endLine: 4, endCharacter: lines[4].length,
    });
    assert.deepEqual(JSON.parse(issue.id), [uri, issue.ruleId, source.indexOf('<img'), source.length]);
  }
});

test('directives at EOF and blank input are handled without creating findings', () => {
  assert.equal(maskRazorDirectives('@model Product'), ' '.repeat('@model Product'.length));
  assert.deepEqual(scan('@using MyApp.Models'), []);
  assert.equal(maskRazorDirectives(''), '');
  assert.equal(maskRazorDirectives(' \r\n\t'), ' \r\n\t');
});

test('unsupported or ambiguous headers remain unmasked and cause safe skips', () => {
  for (const header of [
    '@using (var resource = CreateResource()) {',
    '@using var resource = CreateResource();', '@using Alias = MyApp.Models;',
    '@using static MyApp.Helpers', '@model List<Product>', '@inherits Base<Product>',
    '@model', '@model Product extra', '@Model Product',
    '@model Product <img>', '@model Product // comment',
    '@addTagHelper *, MyApp', '@inject Service Service', '@page',
  ]) {
    const source = `${header}\n<img>`;
    assert.equal(maskRazorDirectives(source), source, header);
    assert.deepEqual(scan(source), [], header);
  }
});

test('masking stops after markup or unsupported Razor begins', () => {
  for (const source of [
    '<div>\n@model Product\n</div><img>',
    '<img src="\n@using MyApp.Models\n">',
    '<script>\n@namespace MyApp.Views\n</script><img>',
    '<!--\n@model Product\n--><img>',
    '@{\n@using MyApp.Models\n}<img>',
  ]) {
    assert.equal(maskRazorDirectives(source), source);
    assert.deepEqual(scan(source), []);
  }
  assert.deepEqual(scan('@model Product\n@if (true) { <img> }'), []);
  assert.deepEqual(scan('@using MyApp.Models\n@addTagHelper *, MyApp\n<img>'), []);
});

test('header masking applies only to Razor file URIs', () => {
  const source = '@model Product\n<img>';
  assert.deepEqual(scanAccessibility(source, 'file:///demo/page.html'), []);
  assert.equal(scanAccessibility(source, 'file:///demo/PAGE.CSHTML?version=1').length, 1);
});

test('empty button produces complete catalog metadata and its opening-tag range', () => {
  const source = '<button></button>';
  const rule = getRule('button-name');
  assert.deepEqual(scan(source), [{
    id: JSON.stringify([uri, rule.id, 0, 8]),
    ruleId: rule.id, title: rule.title,
    message: 'Button has no recognized accessible name. ' + rule.remediation,
    fileUri: uri,
    range: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 8 },
    category: rule.category, severity: rule.severity, wcagCriteria: rule.wcagCriteria,
  }]);
});

for (const source of [
  '<button>Save</button>', '<button><span><strong>Save</strong></span></button>',
  '<button aria-label="Close"></button>', '<button aria-labelledby="runtime-label"></button>',
  '<button title="Close"></button>', '<button><img alt="Search"></button>',
  '<button><span aria-label="Search"></span></button>',
  '<button><img aria-label="Search" alt=""></button>',
  '<button aria-label="Close"><img alt=""></button>',
  '<button aria-label=" ">Save</button>', '<BUTTON>Save</BUTTON>',
  '<button><span role="presentation">Save</span></button>',
  '<button><span role="none">Save</span></button>',
]) {
  test(`recognizes a button naming mechanism: ${source}`, () => assert.deepEqual(scan(source), []));
}

for (const source of [
  '<button> \n\t </button>', '<button>&nbsp;</button>',
  '<button aria-label=" " aria-labelledby="" title=""></button>',
  '<button><img alt=""></button>', '<button><img alt="  "></button>',
  '<button><span hidden>Save</span></button>',
  '<button><span aria-hidden="true">Save</span></button>',
  '<button><!-- Save --></button>',
  '<button><script>Save</script><style>/* Save */</style></button>',
  '<button><template>Save</template></button>',
]) {
  test(`reports an unnamed button: ${source}`, () => {
    assert.deepEqual(scan(source).map((issue) => issue.ruleId), ['button-name']);
  });
}

test('hidden, server-generated and ambiguous button cases are skipped conservatively', () => {
  for (const source of [
    '<button hidden></button>', '<div aria-hidden="true"><button></button></div>',
    '<button runat="server"></button>', '<button asp-action="Save"></button>',
    '<button><span runat="server"></span></button>',
    '<button><my-icon></my-icon></button>', '<button><svg></svg></button>',
    '<button><input value="Save"></button>',
    '<button role="switch"></button>', '<button>',
    '<button hidden="@Model.Hidden"></button>',
    '<button><span hidden="@Model.Hidden">Save</span></button>',
    '<button aria-label="@Model.Name"></button>', '<button>@Model.ButtonText</button>',
    '<label for="save">Save</label><button id="save"></button>',
    '<label>Save<button></button></label>',
  ]) assert.deepEqual(scan(source), [], source);
});

test('image and button rules remain distinct for image-only buttons', () => {
  assert.deepEqual(scan('<button><img src="search.png"></button>').map((issue) => issue.ruleId),
    ['image-text-alternative']);
  assert.deepEqual(scan('<button aria-label="Search"><img></button>').map((issue) => issue.ruleId),
    ['image-text-alternative']);
});

test('mixed findings are source ordered with deterministic distinct IDs', () => {
  const source = '@model Product\r\n<button></button><img><button><img alt=""></button>';
  const issues = scan(source);
  assert.deepEqual(issues.map((issue) => issue.ruleId),
    ['button-name', 'image-text-alternative', 'button-name']);
  assert.equal(new Set(issues.map((issue) => issue.id)).size, 3);
  assert.deepEqual(scan(source), issues);
  assert.deepEqual(issues[0].range, { startLine: 1, startCharacter: 0, endLine: 1, endCharacter: 8 });
});

test('multiline button opening tags retain original ranges after Razor masking', () => {
  for (const newline of ['\n', '\r\n', '\r']) {
    const source = `@model Product${newline}  <button${newline} type="button"></button>`;
    assert.deepEqual(scan(source)[0].range,
      { startLine: 1, startCharacter: 2, endLine: 2, endCharacter: 15 });
  }
});

test('input buttons and non-native ARIA buttons remain outside this detector', () => {
  assert.deepEqual(scan('<input type="submit" value=""><div role="button"></div>'), []);
});

test('empty hyperlink returns complete link metadata and opening-tag range', () => {
  const source = '<a href="/help"></a>';
  const end = source.indexOf('>') + 1;
  const rule = getRule('link-name');
  assert.deepEqual(scan(source), [{
    id: JSON.stringify([uri, rule.id, 0, end]), ruleId: rule.id, title: rule.title,
    message: 'Link has no recognized accessible name. ' + rule.remediation,
    fileUri: uri,
    range: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: end },
    category: rule.category, severity: rule.severity, wcagCriteria: rule.wcagCriteria,
  }]);
});

for (const source of [
  '<a href="/help">Help</a>', '<a href="/help"><span><strong>Help</strong></span></a>',
  '<a href="/help" aria-label="Help"></a>', '<a href="/help" aria-labelledby="help-label"></a>',
  '<a href="/help" title="Help"></a>', '<a href="/help"><img alt="Help"></a>',
  '<a href="/help" aria-label="Help"><img alt=""></a>',
  '<a href="/help"><span role="presentation">Help</span></a>',
  '<a href="/help">Read more</a>', '<A HREF="/help">Help</A>',
  '<a href="@Model.HelpUrl">Help</a>',
]) {
  test(`recognizes hyperlink naming: ${source}`, () => assert.deepEqual(scan(source), []));
}

for (const source of [
  '<a href="/help"> \n\t </a>', '<a href="/help">&nbsp;</a>',
  '<a href="/help" aria-label=" " aria-labelledby="" title=""></a>',
  '<a href="/help"><img alt=""></a>',
  '<a href="/help"><span hidden>Help</span></a>',
  '<a href="/help"><span aria-hidden="true">Help</span></a>',
  '<a href="/help"><!-- Help --><script>Help</script><style>/* Help */</style><template>Help</template></a>',
  '<a href=""></a>', '<a href="#"></a>', '<a href></a>',
  '<a href="@Model.HelpUrl"></a>',
  '<label for="help">Help</label><a id="help" href="/help"></a>',
  '<label>Help<a href="/help"></a></label>',
]) {
  test(`reports unnamed hyperlink: ${source}`, () => {
    assert.deepEqual(scan(source).map((issue) => issue.ruleId), ['link-name']);
  });
}

test('anchors without href and non-native links are outside the hyperlink detector', () => {
  assert.deepEqual(scan('<a id="help"></a><a></a><div role="link"></div>'), []);
});

test('hidden, server-generated and ambiguous hyperlinks are skipped conservatively', () => {
  for (const source of [
    '<a href="/help" hidden></a>', '<div aria-hidden="true"><a href="/help"></a></div>',
    '<a href="/help" runat="server"></a>', '<a asp-action="Help"></a>',
    '<a href="/help" asp-action="Help"></a>',
    '<a href="/help"><span runat="server"></span></a>',
    '<a href="/help"><svg></svg></a>', '<a href="/help"><my-icon></my-icon></a>',
    '<a href="/help" role="button"></a>', '<a href="/help">',
    '<a href="/help" aria-label="@Model.Name"></a>', '<a href="/help">@Model.LinkText</a>',
    '<a href="@Url.Action("Help")"></a>',
  ]) assert.deepEqual(scan(source), [], source);
});

test('link and image findings remain independent for image-only hyperlinks', () => {
  assert.deepEqual(scan('<a href="/help" aria-label="Help"><img src="help.png"></a>')
    .map((issue) => issue.ruleId), ['image-text-alternative']);
  assert.deepEqual(scan('<a href="/help"><img src="help.png"></a>')
    .map((issue) => issue.ruleId), ['image-text-alternative']);
});

test('multiline hyperlink ranges and IDs retain original source positions after masking', () => {
  for (const newline of ['\n', '\r\n', '\r']) {
    const source = `@model Product${newline}  <a${newline} href="/help"></a>`;
    const [issue] = scan(source);
    assert.deepEqual(issue.range, { startLine: 1, startCharacter: 2, endLine: 2, endCharacter: 14 });
    assert.deepEqual(JSON.parse(issue.id), [uri, 'link-name', source.indexOf('<a'), source.indexOf('>') + 1]);
  }
});

test('all three detectors share stable finding generation and source ordering', () => {
  const source = '<a href="/help"></a><button></button><img><a href="#"></a>';
  const issues = scan(source);
  assert.deepEqual(issues.map((issue) => issue.ruleId),
    ['link-name', 'button-name', 'image-text-alternative', 'link-name']);
  assert.equal(new Set(issues.map((issue) => issue.id)).size, 4);
  assert.deepEqual(scan(source), issues);
  assert.notEqual(scanAccessibility(source, 'file:///other.html')[0].id, issues[0].id);
});
