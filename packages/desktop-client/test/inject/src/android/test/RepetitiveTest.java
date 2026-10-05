package android.test;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * The annotation the framework's own {@code InstrumentationTestCase} carries,
 * and which a current device image no longer ships: its android.test jars were
 * trimmed, so the legacy `uiautomator runtest` harness fails to link with
 * "Failed resolution of: Landroid/test/RepetitiveTest" before it ever runs a
 * test. Carrying the annotation in the injector's own dex is what lets the real
 * harness run; nothing in the product depends on it.
 */
@Retention(RetentionPolicy.RUNTIME)
@Target({ ElementType.METHOD })
public @interface RepetitiveTest {
    int numIterations() default 1;
}
