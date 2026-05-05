/**
 * DigiVal — CKEditor 5 + Equation Editor integration
 *
 * Features:
 *  • ƒ(x) toolbar button opens the DigiVal WYSIWYG equation editor
 *  • Insert inserts a rendered KaTeX formula inline in the document
 *  • Double-click any formula to re-open the editor pre-filled for editing
 *  • Ctrl+Enter in the dialog inserts without clicking the button
 *  • Escape closes the dialog
 *  • Formula stored as <span class="dve-formula" data-latex="..."> in HTML output
 */

'use strict';

import {
  ClassicEditor,
  Autosave,
  Essentials,
  Paragraph,
  Heading,
  ImageUtils,
  ImageEditing,
  Bold,
  Italic,
  Underline,
  Strikethrough,
  Code,
  Subscript,
  Superscript,
  FontBackgroundColor,
  FontColor,
  FontFamily,
  FontSize,
  RemoveFormat,
  Highlight,
  HorizontalLine,
  BlockQuote,
  List,
  ButtonView,
  Plugin,
} from 'ckeditor5';

import katex from 'katex';
import 'katex/dist/katex.min.css';
import 'ckeditor5/ckeditor5.css';

// ─── License key ─────────────────────────────────────────────────────────────
const LICENSE_KEY =
  'eyJhbGciOiJFUzI1NiJ9.eyJleHAiOjE3ODM5ODcxOTksImp0aSI6IjRmZmQxMTBlLTlhOWUtNDYwOC1iMzU5LTY3ZWUwZmE3NmVmMSIsImxpY2Vuc2VkSG9zdHMiOlsiMTI3LjAuMC4xIiwibG9jYWxob3N0IiwiMTkyLjE2OC4qLioiLCIxMC4qLiouKiIsIjE3Mi4qLiouKiIsIioudGVzdCIsIioubG9jYWxob3N0IiwiKi5sb2NhbCJdLCJ1c2FnZUVuZHBvaW50IjoiaHR0cHM6Ly9wcm94eS1ldmVudC5ja2VkaXRvci5jb20iLCJkaXN0cmlidXRpb25DaGFubmVsIjpbImNsb3VkIiwiZHJ1cGFsIl0sImxpY2Vuc2VUeXBlIjoiZGV2ZWxvcG1lbnQiLCJmZWF0dXJlcyI6WyJEUlVQIiwiRTJQIiwiRTJXIl0sInZjIjoiNmZjOGQ5MWQifQ.0cGs-5VNF-G6Eq3g_flhdALBKj-RvLDpvgn-o-8KFQtIlpjizdiPKvWWeGd3iApQHn_r0nPqhgA9n6HHfsFz0w';

// ─── SVG icon for toolbar button ─────────────────────────────────────────────
const DVE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">
  <text x="1" y="15" font-size="14" font-family="Georgia,Times New Roman,serif"
        font-style="italic" fill="currentColor">f</text>
  <text x="9" y="13" font-size="9" font-family="Georgia,serif" fill="currentColor">(x)</text>
</svg>`;

// ─── CKEditor Plugin: DigiVal Equation Editor ─────────────────────────────────
class DigiValEquationPlugin extends Plugin {
  static get pluginName() { return 'DigiValEquation'; }

  init() {
    const editor = this.editor;
    this._defineSchema();
    this._defineConverters();
    this._registerCommand();
    this._registerToolbarButton();
  }

  // ── Schema ──────────────────────────────────────────────────────────────────
  _defineSchema() {
    this.editor.model.schema.register('dveFormula', {
      allowWhere: '$text',
      isInline: true,
      isObject: true,
      allowAttributes: ['latex'],
    });
  }

  // ── Converters ───────────────────────────────────────────────────────────────
  _defineConverters() {
    const { conversion } = this.editor;

    // ── HTML → Model (upcast) ──────────────────────────────────────────────
    conversion.for('upcast').elementToElement({
      view: { name: 'span', classes: 'dve-formula' },
      model: (viewEl, { writer }) =>
        writer.createElement('dveFormula', {
          latex: viewEl.getAttribute('data-latex') ?? '',
        }),
    });

    // ── Model → saved HTML (dataDowncast) ─────────────────────────────────
    conversion.for('dataDowncast').elementToElement({
      model: 'dveFormula',
      view: (modelEl, { writer }) => {
        const latex = modelEl.getAttribute('latex') ?? '';
        return writer.createContainerElement('span', {
          class: 'dve-formula',
          'data-latex': latex,
        });
      },
    });

    // ── Model → editing view (editingDowncast) ─────────────────────────────
    // Renders KaTeX inline so the user sees the formula, not LaTeX code.
    conversion.for('editingDowncast').elementToElement({
      model: 'dveFormula',
      view: (modelEl, { writer }) => {
        const latex = modelEl.getAttribute('latex') ?? '';

        // Container — NO inline style here; CSS handles sizing with !important
        // so CKEditor's FontSize plugin cannot cascade into the formula.
        const container = writer.createContainerElement('span', {
          class: 'dve-formula dve-formula--rendered',
          'data-latex': latex,
          title: 'Double-click to edit formula',
          contenteditable: 'false',
        });

        // Raw DOM element — KaTeX writes directly here.
        // We set font-size ON THE DOM NODE inside the callback so it is
        // completely outside CKEditor's attribute pipeline and cannot be
        // overridden by any plugin (FontSize, RemoveFormat, etc.).
        const rendered = writer.createRawElement(
          'span',
          { class: 'dve-formula-inner' },
          (domEl) => {
            // Pin the base font-size directly on the raw DOM node.
            // KaTeX scales to 1.21× this value → formulas render at ~24px.
            domEl.style.cssText =
              'display:inline-block;font-size:20px;vertical-align:middle;line-height:1;';
            this._renderKatex(latex, domEl);
          },
        );

        writer.insert(writer.createPositionAt(container, 0), rendered);
        return container;
      },
    });
  }

  // ── KaTeX rendering helper ────────────────────────────────────────────────
  _renderKatex(latex, domEl) {
    const doRender = () => {
      try {
        // MathLive outputs \displaylines{…} for multiline — KaTeX doesn't
        // support that.  Convert to \begin{gathered}…\end{gathered}.
        let normalized = latex;
        const dlMatch = normalized.match(/^\\displaylines\{([\s\S]*)\}$/);
        if (dlMatch) {
          normalized = `\\begin{gathered}${dlMatch[1]}\\end{gathered}`;
        }

        katex.render(normalized, domEl, {
          throwOnError: false,
          displayMode: false,
          strict: false,
          trust: true,
          output: 'html',  // pure HTML output — faster, no MathML overhead
        });
        // Re-pin size after KaTeX rewrites the element's innerHTML
        domEl.style.cssText =
          'display:inline-block;font-size:20px;vertical-align:middle;line-height:1;';
      } catch {
        domEl.textContent = latex;
      }
    };

    if (katex) {
      doRender();
    } else {
      // KaTeX not yet ready — show raw LaTeX as fallback, re-render on load
      domEl.textContent = latex;
      window.addEventListener('load', () => { if (katex) doRender(); }, { once: true });
    }
  }

  // ── Command ───────────────────────────────────────────────────────────────
  _registerCommand() {
    const editor = this.editor;

    editor.commands.add('dveInsert', {
      execute({ latex = '', targetModel = null } = {}) {
        editor.model.change(writer => {
          if (targetModel) {
            // Edit existing: update attribute in place
            writer.setAttribute('latex', latex, targetModel);
          } else {
            // Insert new formula at cursor
            const el = writer.createElement('dveFormula', { latex });
            editor.model.insertContent(el);
            writer.setSelection(el, 'after');
          }
        });
      },
      refresh() { this.isEnabled = true; },
    });
  }

  // ── Toolbar button ────────────────────────────────────────────────────────
  _registerToolbarButton() {
    const editor = this.editor;

    editor.ui.componentFactory.add('dveEquation', (locale) => {
      const btn = new ButtonView(locale);
      btn.set({
        label: 'Insert Math Formula',
        icon: DVE_ICON,
        tooltip: true,
        withText: false,
      });
      btn.on('execute', () => DveModal.open(editor));
      return btn;
    });
  }
}

// ─── Modal controller — thin wrapper around the self-contained Web Component ──
//
// Drag, minimize, maximize, window controls, keyboard shortcuts and the dialog
// shell are all handled INSIDE <digival-equation-editor>.  This object only
// bridges between CKEditor and the component's public API.
const DveModal = (() => {
  const dveEl = document.getElementById('dve-editor');
  let _editor      = null;
  let _targetModel = null;

  // Component fires 'dve-insert' when the user confirms a formula
  dveEl.addEventListener('dve-insert', (e) => {
    const latex = e.detail?.latex ?? '';
    if (latex && _editor) {
      _editor.execute('dveInsert', { latex, targetModel: _targetModel });
      _editor.editing.view.focus();
    }
    _editor      = null;
    _targetModel = null;
  });

  // Component fires 'dve-close' when dismissed without inserting
  dveEl.addEventListener('dve-close', () => {
    _editor      = null;
    _targetModel = null;
  });

  function open(editor, { latex = '', targetModel = null } = {}) {
    _editor      = editor;
    _targetModel = targetModel;
    dveEl.open(latex);
  }

  return { open };
})();

// ─── CKEditor initialisation ─────────────────────────────────────────────────
ClassicEditor.create({
  attachTo: document.querySelector('#editor'),
  root: {
    placeholder: 'Type or paste content here…',
    initialData: `
<h2>DigiVal Equation Editor — CKEditor 5 Integration</h2>
<p>Click <strong>ƒ(x)</strong> in the toolbar to insert a formula. <strong>Double-click</strong> any formula to edit it.</p>
<p>
  Inline examples:&nbsp;
  <span class="dve-formula" data-latex="E = mc^2"></span>&nbsp;&nbsp;
  <span class="dve-formula" data-latex="a^2 + b^2 = c^2"></span>&nbsp;&nbsp;
  <span class="dve-formula" data-latex="\\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}"></span>&nbsp;&nbsp;
  <span class="dve-formula" data-latex="\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}"></span>&nbsp;&nbsp;
  <span class="dve-formula" data-latex="\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}"></span>
</p>
    `.trim(),
  },
  plugins: [
    Autosave,
    Bold, Italic, Underline, Strikethrough,
    Code, Subscript, Superscript,
    FontBackgroundColor, FontColor, FontFamily, FontSize,
    Highlight, RemoveFormat,
    Essentials, Paragraph,
    ImageEditing, ImageUtils,
    DigiValEquationPlugin,  // ← our plugin
  ],
  toolbar: {
    items: [
      'undo', 'redo', '|',
      'dveEquation',         // ← ƒ(x) button
      '|',
      'fontSize', 'fontFamily', 'fontColor', 'fontBackgroundColor',
      '|',
      'bold', 'italic', 'underline', 'strikethrough',
      '|',
      'subscript', 'superscript', 'code',
      '|',
      'highlight', 'removeFormat',
    ],
    shouldNotGroupWhenFull: false,
  },
  licenseKey: LICENSE_KEY,
  fontFamily: { supportAllValues: true },
  fontSize: {
    options: [10, 12, 14, 'default', 18, 20, 22],
    supportAllValues: true,
  },
  menuBar: { isVisible: true },
})
.then((editor) => {
  console.log('[DigiVal] CKEditor initialised', editor);
  _wireDoubleClick(editor);
})
.catch(console.error);

// ─── Double-click handler — edit existing formula ─────────────────────────────
function _wireDoubleClick(editor) {
  editor.ui.getEditableElement().addEventListener('dblclick', (e) => {
    const formulaEl = e.target.closest('.dve-formula--rendered');
    if (!formulaEl) return;

    e.preventDefault();
    e.stopPropagation();

    // Map DOM element → CKEditor view element → model element
    const domConverter = editor.editing.view.domConverter;
    const viewEl       = domConverter.mapDomToView(formulaEl);
    const modelEl      = viewEl
      ? editor.editing.mapper.toModelElement(viewEl)
      : null;

    const latex = formulaEl.getAttribute('data-latex') ?? '';
    DveModal.open(editor, { latex, targetModel: modelEl });
  });
}

// ─── configUpdateAlert ───────────────────────────────────────────────────────
function configUpdateAlert(config) {
  if (configUpdateAlert._shown) return;
  configUpdateAlert._shown = true;
  if (!config.licenseKey || config.licenseKey === '<YOUR_LICENSE_KEY>') {
    console.warn('[DigiVal] Please set a valid CKEditor 5 license key.');
  }
}
configUpdateAlert({ licenseKey: LICENSE_KEY });
