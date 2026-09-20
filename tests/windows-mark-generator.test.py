"""Fail visibly when the shared source grows outside the renderer's SVG subset."""
import importlib.util
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('windows_mark', ROOT / 'scripts/generate-windows-mark.py')
mark = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mark)


class SharedSourceChecks(unittest.TestCase):
    def test_current_source_compiles(self):
        self.assertEqual(set(mark.compile_source(mark.SOURCE.read_bytes())),
                         {'idle', 'ready', 'unread', 'failed', 'unread-overlay'})

    def test_new_container_transform_is_not_silently_ignored(self):
        data = mark.SOURCE.read_text().replace('<g id=', '<g transform="translate(1 1)" id=', 1)
        self.assertNotEqual(data, mark.SOURCE.read_text())
        with self.assertRaisesRegex(ValueError, 'container attribute'):
            mark.compile_source(data)

    def test_gradient_transform_is_not_silently_ignored(self):
        data = mark.SOURCE.read_text().replace('<linearGradient ', '<linearGradient gradientTransform="rotate(90)" ', 1)
        with self.assertRaisesRegex(ValueError, 'gradient attribute'):
            mark.compile_source(data)

    def test_transparent_stop_is_not_silently_ignored(self):
        data = mark.SOURCE.read_text().replace('<stop ', '<stop stop-opacity="0.5" ', 1)
        with self.assertRaisesRegex(ValueError, 'gradient stop'):
            mark.compile_source(data)

    def test_external_use_is_refused(self):
        data = mark.SOURCE.read_text().replace('href="#', 'href="https://example.invalid/#', 1)
        with self.assertRaisesRegex(ValueError, 'local untransformed'):
            mark.compile_source(data)


if __name__ == '__main__':
    unittest.main()
