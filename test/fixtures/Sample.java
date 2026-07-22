// Sample.java — 綜合 fixture：註解、字串、char、text block、enum、巢狀類別。
package com.example.sample;

import java.util.List;
import java.io.IOException;

/**
 * Class javadoc with braces { } and a quote " inside.
 */
@SuppressWarnings({"unchecked", "rawtypes"})
public class Sample {

  private static final String[] NAMES = {"a", "b", "c"};
  private int count = 0;
  private Runnable hook = new Runnable() {
    public void run() {
      // anonymous class body — not its own unit
    }
  };

  Sample(int count) {
    this.count = count;
  }

  static {
    // static initializer — not its own unit
  }

  /** don't split this { */
  public String describe() throws IOException {
    String url = "http://example.com/?q={x}";
    char open = '{';
    char esc = '\'';
    /* block comment with "quotes" and { */
    if (count > 0) {
      return url + open + esc;
    }
    return "";
  }

  /* leading block comment */
  public String render() {
    return """
        { "json": "yes" } // not a comment
        }}}
        """
        + NAMES[0]
        + "!";
  }

  @SafeVarargs
  public static <T extends Comparable<? super T>> void sort(List<T> l, T... extras) {
    l.sort(null);
  }

  enum Kind {
    A {
      void hidden() {}
    },
    B;
    String label() {
      return name();
    }
  }

  static class Helper {

    String help() {
      return "help";
    }

    class Deep {
      void deep() {
        count++;
      }
    }
  }
}
