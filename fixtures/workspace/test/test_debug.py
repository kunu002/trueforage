import os
import unittest
from src.debug import get_debug_flag


class DebugTest(unittest.TestCase):
    def test_false(self):
        for value in ("", "0", "false", "no"):
            os.environ["FLASK_DEBUG"] = value
            self.assertFalse(get_debug_flag())


if __name__ == "__main__":
    unittest.main()
