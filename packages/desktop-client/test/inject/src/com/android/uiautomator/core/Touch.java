package com.android.uiautomator.core;

import com.android.uiautomator.testrunner.UiAutomatorTestCase;

import android.os.SystemClock;
import android.view.InputDevice;
import android.view.MotionEvent;

/**
 * Real fingers on a real phone screen.
 *
 * The phone's own `input` injector cannot be used for this journey: `input tap`
 * works, but `input motionevent DOWN/MOVE/UP` delivers nothing to a live app on
 * this build, and it has only ever had one pointer, so a two-finger scroll was
 * impossible. The shell may not write the touch node directly either (SELinux
 * denies it). uiautomator runs with INJECT_EVENTS and can build a real
 * multi-pointer MotionEvent, which is what every gesture here needs.
 *
 * The gesture arrives in a file, because `uiautomator runtest` carries no
 * arguments: /data/local/tmp/j2-gesture.txt holds
 *
 *     verb x1 y1 x2 y2 param hold
 *
 * with verb one of tap, longpress, drag, twofinger, pinch; phone pixels; param a
 * millisecond count (hold, drag duration) or a frame count; and hold the
 * milliseconds a drag stays down before it first moves, or the pace between
 * two fingers' frames.
 *
 * Package note: UiDevice.getAutomatorBridge() is package-private, so this class
 * lives in com.android.uiautomator.core; the real class comes from the phone's
 * own /system/framework/uiautomator.jar.
 */
public class Touch extends UiAutomatorTestCase {

    private static final String GESTURE = "/data/local/tmp/desklink-gesture.txt";
    private static final int DOWN = MotionEvent.ACTION_DOWN;
    private static final int POINTER_DOWN = MotionEvent.ACTION_POINTER_DOWN
            | (1 << MotionEvent.ACTION_POINTER_INDEX_SHIFT);
    private static final int MOVE = MotionEvent.ACTION_MOVE;
    private static final int POINTER_UP = MotionEvent.ACTION_POINTER_UP
            | (1 << MotionEvent.ACTION_POINTER_INDEX_SHIFT);
    private static final int UP = MotionEvent.ACTION_UP;

    private UiAutomatorBridge bridge;

    public void testRun() throws Exception {
        bridge = getUiDevice().getAutomatorBridge();
        String[] p = readGesture();
        String verb = p[0];
        int x1 = Integer.parseInt(p[1]), y1 = Integer.parseInt(p[2]);
        int x2 = Integer.parseInt(p[3]), y2 = Integer.parseInt(p[4]);
        int param = p.length > 5 ? Integer.parseInt(p[5]) : 0;
        int hold = p.length > 6 ? Integer.parseInt(p[6]) : 0;
        if ("tap".equals(verb)) tap(x1, y1);
        else if ("longpress".equals(verb)) longPress(x1, y1, param);
        else if ("drag".equals(verb)) drag(x1, y1, x2, y2, param, hold);
        else if ("draghold".equals(verb)) dragHold(x1, y1, x2, y2, param, hold);
        else if ("lift".equals(verb)) lift(x2, y2);
        else if ("twofinger".equals(verb)) twoFinger(x1, y1, x2, y2, param, hold);
        else if ("fingersdown".equals(verb)) fingersDown(x1, y1);
        else if ("fingersmove".equals(verb)) fingersMove(x1, y1, x2, y2, param, hold);
        else if ("pinch".equals(verb)) pinch(x1, y1, param, hold);
        else throw new IllegalArgumentException("unknown gesture " + verb);
    }

    private String[] readGesture() throws Exception {
        java.io.FileReader file = new java.io.FileReader(GESTURE);
        StringBuilder text = new StringBuilder();
        int c;
        while ((c = file.read()) != -1) text.append((char) c);
        file.close();
        return text.toString().trim().split("[,\\s]+");
    }

    private void tap(int x, int y) throws Exception {
        long down = SystemClock.uptimeMillis();
        send(down, down, DOWN, 1, new int[][]{{x, y}});
        sleep(70);
        send(down, SystemClock.uptimeMillis(), UP, 1, new int[][]{{x, y}});
    }

    private void longPress(int x, int y, int holdMs) throws Exception {
        long down = SystemClock.uptimeMillis();
        send(down, down, DOWN, 1, new int[][]{{x, y}});
        sleep(Math.max(holdMs, 900));
        send(down, SystemClock.uptimeMillis(), UP, 1, new int[][]{{x, y}});
    }

    /**
     * A drag. `holdMs` before the first move is what a trackpad-shaped client
     * needs: its own long-press arms a press, so a selection is that hold and
     * then the movement, not the movement alone.
     */
    private void drag(int x1, int y1, int x2, int y2, int durationMs, int holdMs) throws Exception {
        int steps = Math.max(8, durationMs / 16);
        long down = SystemClock.uptimeMillis();
        send(down, down, DOWN, 1, new int[][]{{x1, y1}});
        if (holdMs > 0) sleep(holdMs);
        for (int step = 1; step < steps; step++) {
            float t = (float) step / steps;
            sleep(16);
            send(down, SystemClock.uptimeMillis(), MOVE, 1, new int[][]{
                    {Math.round(x1 + (x2 - x1) * t), Math.round(y1 + (y2 - y1) * t)}});
        }
        release(down, x2, y2);
    }

    /** Both fingers down, left there: the harness process ends, the touch does not. */
    private void fingersDown(int x1, int y1) throws Exception {
        long down = SystemClock.uptimeMillis();
        send(down, down, DOWN, 1, new int[][]{{x1, y1}});
        sleep(16);
        send(down, SystemClock.uptimeMillis(), POINTER_DOWN, 2, new int[][]{{x1, y1}, {x1 + 110, y1}});
        sleep(400);
    }

    /** The rest of that gesture, in a fresh harness process. */
    private void fingersMove(int x1, int y1, int x2, int y2, int steps, int stepMs) throws Exception {
        int gap = 110;
        int pace = stepMs > 0 ? stepMs : 16;
        long down = SystemClock.uptimeMillis();
        for (int step = 1; step < steps; step++) {
            float t = (float) step / steps;
            int ax = Math.round(x1 + (x2 - x1) * t), ay = Math.round(y1 + (y2 - y1) * t);
            sleep(pace);
            send(down, SystemClock.uptimeMillis(), MOVE, 2, new int[][]{{ax, ay}, {ax + gap, ay}});
        }
        send(down, SystemClock.uptimeMillis(), POINTER_UP, 2, new int[][]{{x2, y2}, {x2 + gap, y2}});
        sleep(16);
        release(down, x2, y2);
    }

    /**
     * The drag without its release, and the release on its own. A release sent
     * straight after a stream of moves is the event this image drops, and a
     * drag that never ends leaves the desktop holding a button down; splitting
     * them across two harness processes is what makes the lift land.
     */
    private void dragHold(int x1, int y1, int x2, int y2, int durationMs, int holdMs) throws Exception {
        int steps = Math.max(8, durationMs / 16);
        long down = SystemClock.uptimeMillis();
        send(down, down, DOWN, 1, new int[][]{{x1, y1}});
        if (holdMs > 0) sleep(holdMs);
        for (int step = 1; step < steps; step++) {
            float t = (float) step / steps;
            sleep(16);
            send(down, SystemClock.uptimeMillis(), MOVE, 1, new int[][]{
                    {Math.round(x1 + (x2 - x1) * t), Math.round(y1 + (y2 - y1) * t)}});
        }
        sleep(200);
    }

    private void lift(int x, int y) throws Exception {
        long now = SystemClock.uptimeMillis();
        send(now, now, UP, 1, new int[][]{{x, y}});
        sleep(150);
        send(now, SystemClock.uptimeMillis(), UP, 1, new int[][]{{x, y}});
        sleep(400);
    }

    /**
     * A pinch about (x1, y1): two fingers whose gap changes, which is the
     * gesture that zooms a picture. `gap` is the distance in pixels between
     * the two fingers at the end of the movement (they start 110 apart), so a
     * smaller gap zooms out, `steps` the number of frames and the pace of
     * those frames is fixed.
     */
    private void pinch(int x1, int y1, int gap, int steps) throws Exception {
        int pace = 16;
        int x2 = x1, y2 = y1;
        int start = 110;
        long down = SystemClock.uptimeMillis();
        send(down, down, DOWN, 1, new int[][]{{x1, y1}});
        sleep(16);
        send(down, SystemClock.uptimeMillis(), POINTER_DOWN, 2, new int[][]{{x1, y1}, {x1 + start, y1}});
        for (int step = 1; step < steps; step++) {
            float t = (float) step / (steps - 1);
            int ax = Math.round(x1 + (x2 - x1) * t), ay = Math.round(y1 + (y2 - y1) * t);
            int now = Math.round(start + (gap - start) * t);
            sleep(pace > 0 ? pace : 16);
            send(down, SystemClock.uptimeMillis(), MOVE, 2, new int[][]{{ax, ay}, {ax + now, ay}});
        }
        send(down, SystemClock.uptimeMillis(), POINTER_UP, 2, new int[][]{{x2, y2}, {x2 + gap, y2}});
        sleep(16);
        release(down, x2 + gap, y2);
    }

    private void twoFinger(int x1, int y1, int x2, int y2, int steps, int stepMs) throws Exception {
        int gap = 110;
        int pace = stepMs > 0 ? stepMs : 16;
        long down = SystemClock.uptimeMillis();
        send(down, down, DOWN, 1, new int[][]{{x1, y1}});
        sleep(16);
        send(down, SystemClock.uptimeMillis(), POINTER_DOWN, 2, new int[][]{{x1, y1}, {x1 + gap, y1}});
        for (int step = 1; step < steps; step++) {
            float t = (float) step / (steps - 1);
            int ax = Math.round(x1 + (x2 - x1) * t), ay = Math.round(y1 + (y2 - y1) * t);
            sleep(pace);
            send(down, SystemClock.uptimeMillis(), MOVE, 2, new int[][]{{ax, ay}, {ax + gap, ay}});
        }
        send(down, SystemClock.uptimeMillis(), POINTER_UP, 2, new int[][]{{x2, y2}, {x2 + gap, y2}});
        sleep(16);
        release(down, x2, y2);
    }

    /**
     * Lift every finger. A release that lands on exactly the last move is the
     * one event a run loses on a current image — the dispatcher folds it into
     * the move it duplicates — and a finger that never comes up leaves the
     * desktop with the button down and the gesture unfinished. Releasing a
     * pixel off the last position, twice, is what makes the lift land; a real
     * finger's release point is within that pixel of its last move anyway.
     */
    private void release(long down, int x, int y) throws Exception {
        send(down, SystemClock.uptimeMillis(), UP, 1, new int[][]{{x + 1, y}});
        sleep(120);
        send(down, SystemClock.uptimeMillis(), UP, 1, new int[][]{{x + 1, y}});
        sleep(400);
    }

    private void sleep(long ms) throws Exception {
        Thread.sleep(ms);
    }

    private void send(long down, long now, int action, int pointers, int[][] at) throws Exception {
        MotionEvent.PointerProperties[] props = new MotionEvent.PointerProperties[pointers];
        MotionEvent.PointerCoords[] coords = new MotionEvent.PointerCoords[pointers];
        for (int i = 0; i < pointers; i++) {
            props[i] = new MotionEvent.PointerProperties();
            props[i].id = i;
            props[i].toolType = MotionEvent.TOOL_TYPE_FINGER;
            coords[i] = new MotionEvent.PointerCoords();
            coords[i].x = at[i][0];
            coords[i].y = at[i][1];
            coords[i].pressure = 1;
            coords[i].size = 1;
        }
        MotionEvent event = MotionEvent.obtain(down, now, action, pointers, props, coords,
                0, 0, 1, 1, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0);
        boolean accepted = bridge.injectInputEvent(event, true);
        System.out.println("inject action=" + action + " pointers=" + pointers
                + " at=" + at[0][0] + "," + at[0][1] + " accepted=" + accepted);
        event.recycle();
    }
}
