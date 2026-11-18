package com.chapterly.service;

import com.chapterly.error.TtsException;
import com.chapterly.error.TtsException.Reason;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Comparator;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.PriorityQueue;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;

/**
 * Runs jobs for a local TTS engine (Kokoro) at most {@code maxConcurrent} at a time, in our
 * order instead of the engine's: {@link Priority#NOW} (the chunk a listener is waiting for)
 * before {@link Priority#PREFETCH}, FIFO within a priority.
 *
 * <p>The caller's thread waits for its turn and then runs the job itself, so the time spent
 * waiting never counts toward the provider's own timeout. A job that is still waiting can be
 * cancelled by request id ({@link #cancel}); the waiting caller then gets a
 * {@link CancellationException}. A job that already started runs to its end.
 *
 * <p>Ids cancelled before their request arrived (the DELETE can overtake the POST) are
 * remembered for a minute, and such a request is cancelled on arrival.
 */
public class TtsQueue {

    private static final Logger log = LoggerFactory.getLogger(TtsQueue.class);

    static final int REMEMBERED_CANCELS = 512;
    static final long REMEMBER_CANCEL_NANOS = 60_000_000_000L;

    public enum Priority {
        NOW, PREFETCH;

        /** "now" / "prefetch" (any case); null or blank = NOW. */
        public static Priority parse(String value) throws TtsException {
            if (value == null || value.isBlank()) {
                return NOW;
            }
            return switch (value.strip().toLowerCase(Locale.ROOT)) {
                case "now" -> NOW;
                case "prefetch" -> PREFETCH;
                default -> throw new TtsException(Reason.BAD_INPUT, "Priority must be 'now' or 'prefetch'");
            };
        }
    }

    @FunctionalInterface
    public interface Job<T> {
        T call() throws TtsException;
    }

    private static final class Waiter {
        final String id;
        final Priority priority;
        final long seq;
        final long enqueuedAt = System.nanoTime();
        final CompletableFuture<Void> turn = new CompletableFuture<>();

        Waiter(String id, Priority priority, long seq) {
            this.id = id;
            this.priority = priority;
            this.seq = seq;
        }
    }

    private final int maxConcurrent;
    private final PriorityQueue<Waiter> waiting = new PriorityQueue<>(
            Comparator.comparing((Waiter w) -> w.priority).thenComparingLong(w -> w.seq));
    /** id -> time it was cancelled while not queued (bounded, oldest first). */
    private final Map<String, Long> cancelledEarly = new LinkedHashMap<>();
    private int running;
    private long seq;

    public TtsQueue(int maxConcurrent) {
        if (maxConcurrent < 1) {
            throw new IllegalArgumentException("maxConcurrent must be at least 1");
        }
        this.maxConcurrent = maxConcurrent;
    }

    public int maxConcurrent() {
        return maxConcurrent;
    }

    /** Jobs waiting for their turn. */
    public synchronized int queued() {
        return waiting.size();
    }

    /** Jobs running now. */
    public synchronized int running() {
        return running;
    }

    /**
     * Waits for a turn, then runs {@code job} on the calling thread.
     *
     * @param id request id for {@link #cancel}, or null if the job can't be cancelled
     * @throws CancellationException if the job was cancelled before it started
     */
    public <T> T run(String id, Priority priority, Job<T> job) throws TtsException {
        Waiter waiter = enqueue(id, priority == null ? Priority.NOW : priority);
        try {
            waiter.turn.get();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            abandon(waiter);
            throw new CancellationException("Interrupted while waiting in the TTS queue");
        } catch (ExecutionException e) {
            throw new CancellationException("TTS request " + id + " was cancelled while queued");
        }
        if (log.isDebugEnabled()) {
            log.debug("TTS job {} ({}) started after {} ms in the queue; {} still waiting",
                    label(id), waiter.priority, (System.nanoTime() - waiter.enqueuedAt) / 1_000_000, queued());
        }
        try {
            return job.call();
        } finally {
            release();
        }
    }

    /**
     * Removes the job with this id if it is still waiting. Never fails: an unknown id (already
     * running, finished, or not arrived yet) is remembered briefly so a late arrival is dropped.
     *
     * @return true if a waiting job was removed
     */
    public boolean cancel(String id) {
        if (id == null) {
            return false;
        }
        boolean removed = false;
        synchronized (this) {
            for (Iterator<Waiter> it = waiting.iterator(); it.hasNext(); ) {
                Waiter w = it.next();
                if (id.equals(w.id)) {
                    it.remove();
                    w.turn.completeExceptionally(new CancellationException());
                    removed = true;
                }
            }
            if (!removed) {
                rememberCancel(id);
            }
        }
        log.debug("TTS job {} cancel: {}", id, removed ? "removed from the queue" : "not queued");
        return removed;
    }

    private synchronized Waiter enqueue(String id, Priority priority) {
        if (id != null && wasCancelledEarly(id)) {
            throw new CancellationException("TTS request " + id + " was cancelled before it arrived");
        }
        Waiter waiter = new Waiter(id, priority, seq++);
        waiting.add(waiter);
        log.debug("TTS job {} ({}) queued; {} waiting, {} running", label(id), priority, waiting.size(), running);
        drain();
        return waiter;
    }

    private synchronized void release() {
        running--;
        drain();
    }

    /** Gives up a place: removes the waiter, or frees the slot it was just given. */
    private synchronized void abandon(Waiter waiter) {
        if (!waiting.remove(waiter) && waiter.turn.isDone() && !waiter.turn.isCompletedExceptionally()) {
            release();
        }
    }

    private void drain() {
        while (running < maxConcurrent && !waiting.isEmpty()) {
            Waiter next = waiting.poll();
            running++;
            next.turn.complete(null);
        }
    }

    private void rememberCancel(String id) {
        cancelledEarly.put(id, System.nanoTime());
        while (cancelledEarly.size() > REMEMBERED_CANCELS) {
            cancelledEarly.remove(cancelledEarly.keySet().iterator().next());
        }
    }

    private boolean wasCancelledEarly(String id) {
        long now = System.nanoTime();
        cancelledEarly.values().removeIf(t -> now - t > REMEMBER_CANCEL_NANOS);
        return cancelledEarly.remove(id) != null;
    }

    private static String label(String id) {
        return id == null ? "(no id)" : id;
    }
}
