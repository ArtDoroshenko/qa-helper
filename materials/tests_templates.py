from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
import re
from types import SimpleNamespace

from django.core.paginator import Paginator
from django.template.loader import get_template, render_to_string
from django.test import RequestFactory, SimpleTestCase

from notes.forms import AttachmentForm, NoteForm


class FormStructureParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.form_depth = 0
        self.nested_forms = False
        self.ids = []
        self.references = []

    def handle_starttag(self, tag, attributes):
        attrs = dict(attributes)
        if tag == "form":
            self.form_depth += 1
            self.nested_forms |= self.form_depth > 1
        if "id" in attrs:
            self.ids.append(attrs["id"])
        for attribute in ("for", "form", "aria-controls", "aria-labelledby"):
            self.references.extend(attrs.get(attribute, "").split())

    def handle_endtag(self, tag):
        if tag == "form":
            self.form_depth -= 1


class TemplateContracts(SimpleTestCase):
    def test_palette_matches_accepted_reference_in_both_themes(self):
        css = (Path(__file__).resolve().parent.parent / "static/css/app.css").read_text()
        # Fixed values from the accepted design, independent of computed contrast.
        expected = {
            ":root": {"bg": "#ffffff", "surface-soft": "#f8f9fb", "ink": "#242932",
                      "muted": "#697280", "line": "#e5e9ef", "accent": "#006adf",
                      "tint": "#ecf4ff", "amber": "#fff3d7", "note": "#826018",
                      "success": "#267452", "danger": "#b23939", "radius": "16px",
                      "primary": "#007aff", "primary-text": "#ffffff"},
            '[data-theme="dark"]': {"bg": "#191c23", "surface-soft": "#20242d", "ink": "#e5e9f0",
                      "muted": "#a2acbb", "line": "#363d49", "accent": "#8bbcff",
                      "tint": "#263955", "amber": "#403620", "note": "#f1ce84",
                      "success": "#89d0ae", "danger": "#ffadad"},
        }
        for selector, values in expected.items():
            blocks = re.findall(re.escape(selector) + r"\s*\{([^}]+)\}", css)
            block = blocks[0]
            actual = dict(re.findall(r"--([\w-]+):\s*([^;]+);", block))
            for name, value in values.items():
                with self.subTest(theme=selector, token=name):
                    self.assertEqual(actual[name], value)
            for name in ("surface", "field", "header"):
                self.assertEqual(actual[name], values["bg"])

    def test_reference_component_dimensions_and_semantic_colors(self):
        css = (Path(__file__).resolve().parent.parent / "static/css/app.css").read_text()
        expected = {
            ".note-workbench": {"grid-template-columns": "168px minmax(0, 1fr)", "border-radius": "var(--qa-card-radius)"},
            ".note-workbench .note-field textarea": {"min-height": "220px", "font-size": "13px", "line-height": "1.9"},
            ".note-side-item.active": {"color": "var(--note)", "background": "var(--amber)"},
            ".material-open": {"padding": "16px", "gap": "var(--qa-gap)"},
            ".material-glyph.note": {"color": "var(--note)", "background": "var(--amber)"},
            ".json-pane-head": {"min-height": "50px", "padding": "10px 14px", "background": "var(--surface-soft)"},
            ".json-pane textarea, .json-output": {"min-height": "var(--qa-code-min)", "padding": "18px 14px", "background": "var(--bg)"},
            ".primary-action": {"min-height": "var(--qa-control)", "padding": "9px 12px", "background": "var(--primary)", "color": "var(--primary-text)"},
        }
        for selector, values in expected.items():
            blocks = re.findall(re.escape(selector) + r"\s*\{([^}]+)\}", css)
            declarations = [dict(re.findall(r"([\w-]+):\s*([^;]+);", block)) for block in blocks]
            actual = max(declarations, key=lambda block: len(values.keys() & block.keys()))
            for name, value in values.items():
                with self.subTest(selector=selector, property=name):
                    self.assertEqual(actual[name], value)

    def test_shared_geometry_contract_for_all_workspace_pages(self):
        css = (Path(__file__).resolve().parent.parent / "static/css/app.css").read_text()
        root = re.search(r":root\s*\{([^}]+)\}", css).group(1)
        values = dict(re.findall(r"--([\w-]+):\s*([^;]+);", root))
        expected = {
            "qa-content-max": "1180px", "qa-sidebar": "184px", "qa-header-min": "70px",
            "qa-page-y": "30px", "qa-page-x": "28px", "qa-gap": "12px",
            "qa-section-gap": "24px", "qa-control": "40px", "qa-control-radius": "9px",
            "qa-card-radius": "16px", "qa-panel-pad": "20px", "qa-code-min": "310px",
        }
        for name, value in expected.items():
            with self.subTest(token=name):
                self.assertEqual(values[name], value)
        self.assertRegex(css, r"\.dashboard\s*\{[^}]*max-width:\s*var\(--qa-content-max\);[^}]*padding:\s*var\(--qa-page-y\) var\(--qa-page-x\)")
        for page in ("note-editor-page", "note-delete-page", "base64-page", "materials-page",
                     "json-page", "test-data-page", "profile-page", "account-manage"):
            with self.subTest(page=page):
                self.assertNotRegex(css, r"\." + page + r"\s*\{[^}]*max-width:")
        for template in ("accounts/dashboard.html", "notes/note_form.html",
                         "notes/note_confirm_delete.html", "materials/material_list.html",
                         "materials/json_tool.html", "materials/base64_tool.html",
                         "materials/test_data_tool.html",
                         "accounts/profile.html", "allauth/layouts/manage.html"):
            with self.subTest(template=template):
                source = (Path(__file__).resolve().parent.parent / "templates" / template).read_text()
                self.assertRegex(source, r'<main class="dashboard(?:\s|\")')
        self.assertNotRegex(css, r"max-width:\s*(?:900|1060|1220)px")
        self.assertRegex(css, r"\.workspace\s*\{[^}]*grid-template-columns:\s*var\(--qa-sidebar\) minmax\(0, 1fr\)")
        self.assertRegex(css, r"\.base64-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)")
        self.assertRegex(css, r"\.json-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)")
        self.assertIn("@media (max-width: 850px)", css)
        self.assertIn("@media (max-width: 580px)", css)
        self.assertIn("@media (pointer: coarse)", css)

    def test_json_editor_panels_share_height_and_scroll_long_content(self):
        css = (Path(__file__).resolve().parent.parent / "static/css/app.css").read_text()

        def declarations(selector):
            block = re.search(re.escape(selector) + r"\s*\{([^}]+)\}", css).group(1)
            return dict(re.findall(r"([\w-]+):\s*([^;]+);", block))

        self.assertEqual(declarations(".json-pane")["grid-template-rows"], "58px var(--qa-code-min) 40px")
        body = declarations(".json-pane textarea, .json-output")
        for property_name in ("height", "min-height", "max-height"):
            self.assertEqual(body[property_name], "var(--qa-code-min)")
        self.assertEqual(body["overflow"], "auto")
        self.assertEqual(declarations(".json-pane textarea")["resize"], "none")
        self.assertEqual(declarations(".json-pane-foot")["height"], "40px")
        narrow = re.search(r"@media \(max-width: 850px\)\s*\{(.*?)\n\}", css, re.S).group(1)
        self.assertIn(".json-grid { grid-template-columns: 1fr; }", narrow)
        self.assertIn(".json-output-pane { border-top: 1px solid var(--line); border-left: 0; }", narrow)

    def test_auth_manage_input_colors_use_theme_variables_at_original_specificity(self):
        css = (Path(__file__).resolve().parent.parent / "static/css/app.css").read_text()
        variables = {}
        for theme, selector in (("light", ":root"), ("dark", '[data-theme="dark"]')):
            block = re.search(re.escape(selector) + r"\s*\{([^}]+)\}", css).group(1)
            variables[theme] = dict(re.findall(r"--([\w-]+):\s*(#[\da-fA-F]{6})", block))

        def luminance(color):
            rgb = [int(color[index:index + 2], 16) / 255 for index in (1, 3, 5)]
            linear = [value / 12.92 if value <= .04045 else ((value + .055) / 1.055) ** 2.4 for value in rgb]
            return sum(weight * value for weight, value in zip((.2126, .7152, .0722), linear))

        for panel in ("account-panel", "manage-card"):
            block = re.search(r"\." + panel + r" input:not\([^{}]+\{([^}]+)\}", css).group(1)
            self.assertRegex(block, r"color:\s*var\(--ink\)")
            self.assertRegex(block, r"background:\s*var\(--field\)")
            self.assertRegex(block, r"border:\s*1px solid var\(--line\)")
            for input_type in ("text", "email", "password"):
                for theme, values in variables.items():
                    with self.subTest(panel=panel, input_type=input_type, theme=theme):
                        ink, field = luminance(values["ink"]), luminance(values["field"])
                        self.assertGreaterEqual((max(ink, field) + .05) / (min(ink, field) + .05), 4.5)

    def setUp(self):
        self.request = RequestFactory().get("/")
        self.request.user = SimpleNamespace(
            is_authenticated=True, first_name="QA", email="qa@example.com",
        )

    def _check_structure(self, template, context):
        rendered = render_to_string(template, context, request=self.request)
        parser = FormStructureParser()
        parser.feed(rendered)
        self.assertFalse(parser.nested_forms)
        self.assertEqual(parser.form_depth, 0)
        self.assertEqual(len(parser.ids), len(set(parser.ids)))
        self.assertTrue(set(parser.references).issubset(set(parser.ids)))
        return rendered

    def test_new_and_existing_note_have_valid_native_forms_and_autosave_hooks(self):
        base = {"form": NoteForm(), "note_sidebar": []}
        self._check_structure("notes/note_form.html", base)
        now = datetime(2026, 9, 29, tzinfo=timezone.utc)
        note = SimpleNamespace(pk=1, title="Note", updated_at=now, bookmarked_at=None)
        attachment = SimpleNamespace(pk=2, original_name="report.txt", size=12, created_at=now)
        rendered = self._check_structure("notes/note_form.html", {
            **base, "note": note, "attachments": [attachment], "attachment_form": AttachmentForm(),
        })
        for selector in ('data-note-autosave', 'data-autosave-delay="1500"', 'data-save-status',
                         'data-save-state', 'data-last-saved', 'data-attachment-upload',
                         'class="inline-confirm attachment-confirm"'):
            self.assertIn(selector, rendered)

    def test_json_naming_form_is_separate_hidden_and_required(self):
        rendered = self._check_structure("materials/json_tool.html", {"material": None})
        self.assertIn("data-json-save-panel hidden", rendered)
        self.assertIn('data-json-title required maxlength="120"', rendered)
        self.assertIn("data-json-save-new hidden", rendered)
        self.assertIn("/static/js/json.js", rendered)

    def test_test_data_forms_are_separate_and_result_is_initially_empty(self):
        rendered = self._check_structure("materials/test_data_tool.html", {
            "dataset": None, "saved_count": 0, "saved_limit": 10,
            "field_groups": (("Личные данные", (("name", "ФИО"),)),),
            "initial_dataset": None,
        })
        self.assertIn('data-td-generator', rendered)
        self.assertIn('data-td-checks hidden', rendered)
        self.assertIn('data-td-save-panel hidden', rendered)
        self.assertIn('data-td-open-save disabled', rendered)
        self.assertIn('/static/js/test_data.js', rendered)

    def test_catalog_chooser_and_row_structure(self):
        now = datetime(2026, 9, 29, tzinfo=timezone.utc)
        note = SimpleNamespace(pk=1, attachment_count=3)
        material = SimpleNamespace(pk=2)
        items = [
            {"kind": "note", "object": note, "title": "Note", "updated_at": now},
            {"kind": "json", "object": material, "title": "JSON", "updated_at": now},
        ]
        rendered = self._check_structure("materials/material_list.html", {
            "page_obj": Paginator(items, 20).get_page(1),
            "material_type": "all", "sort": "added",
        })
        self.assertIn('class="material-list"', rendered)
        self.assertIn("Заметка · 3 влож.", rendered)

    def test_touched_templates_compile(self):
        for template in ("base.html", "includes/sidebar.html", "includes/icon.html",
                         "accounts/dashboard.html", "notes/note_list.html",
                         "allauth/layouts/base.html", "allauth/layouts/manage.html"):
            with self.subTest(template=template):
                get_template(template)
