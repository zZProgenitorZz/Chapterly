package com.chapterly.service;

import com.chapterly.error.TtsException;
import com.chapterly.service.TtsQueue.Priority;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BooleanSupplier;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

@Timeout(10)
class TtsQueueTest {

    private final List<Thread> threads = new ArrayList<>();
    private final List<String> order = Collections.synchronizedList(new ArrayList<>());

    @AfterEach
    void stopThreads() {
        threads.forEach(Thread::interrupt);
    }

    /** Runs a job on its own thread; the job records its name and optionally waits for a latch. */
    private CompletableFuture<String> submit(TtsQueue queue, String id, Priority priority, CountDownLatch hold) {
        CompletableFuture<String> result = new CompletableFuture<>();
        Thread t = Thread.ofVirtual().start(() -> {
            try {
                result.complete(queue.run(id, priority, () -> {
                    order.add(id);
                    if (hold != null) {
                        try {
                            hold.await();
                        } catch (InterruptedException e) {
                            Thread.currentThread().interrupt();
                        }
                    }
                    return id;
                }));
            } catch (Throwable e) {
                result.completeExceptionally(e);
            }
        });
        threads.add(t);
        return result;
    }

    private static void await(BooleanSupplier condition) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (!condition.getAsBoolean()) {
            if (System.nanoTime() > deadline) {
                throw new AssertionError("condition not reached");
            }
            Thread.sleep(2);
        }
    }

    @Test
    void nowRunsBeforePrefetchAndFifoWithinAPriority() throws Exception {
        TtsQueue queue = new TtsQueue(1);
        CountDownLatch blocker = new CountDownLatch(1);
        CompletableFuture<String> first = submit(queue, "running", Priority.PREFETCH, blocker);
        await(() -> queue.running() == 1);

        // Enqueue one at a time so the arrival order is known.
        List<CompletableFuture<String>> rest = new ArrayList<>();
        String[][] jobs = {{"p1", "PREFETCH"}, {"p2", "PREFETCH"}, {"n1", "NOW"}, {"n2", "NOW"}};
        for (String[] job : jobs) {
            int before = queue.queued();
            rest.add(submit(queue, job[0], Priority.valueOf(job[1]), null));
            await(() -> queue.queued() == before + 1);
        }

        blocker.countDown();
        first.get(5, TimeUnit.SECONDS);
        for (CompletableFuture<String> f : rest) {
            f.get(5, TimeUnit.SECONDS);
        }
        assertThat(order).containsExactly("running", "n1", "n2", "p1", "p2");
    }

    @Test
    void cancellingAQueuedJobRemovesItAndItsCallerGetsCancellationException() throws Exception {
        TtsQueue queue = new TtsQueue(1);
        CountDownLatch blocker = new CountDownLatch(1);
        submit(queue, "a", Priority.NOW, blocker);
        await(() -> queue.running() == 1);
        CompletableFuture<String> b = submit(queue, "b", Priority.PREFETCH, null);
        await(() -> queue.queued() == 1);

        assertThat(queue.cancel("b")).isTrue();
        assertThat(queue.queued()).isZero();
        // b was completed with the CancellationException, which get() throws as a
        // CancellationException (newer JDKs wrap it in one with message "get" and the original as cause).
        assertThatThrownBy(() -> b.get(5, TimeUnit.SECONDS))
                .isInstanceOf(CancellationException.class)
                .satisfies(e -> assertThat(e.getCause() instanceof CancellationException ? e.getCause() : e)
                        .hasMessage("TTS request b was cancelled while queued"));

        blocker.countDown();
        await(() -> queue.running() == 0);
        assertThat(order).containsExactly("a"); // b never reached the engine
    }

    @Test
    void cancellingAnUnknownOrRunningIdIsHarmless() throws Exception {
        TtsQueue queue = new TtsQueue(1);
        assertThat(queue.cancel("nobody")).isFalse();
        assertThat(queue.cancel(null)).isFalse();

        CountDownLatch blocker = new CountDownLatch(1);
        CompletableFuture<String> running = submit(queue, "r", Priority.NOW, blocker);
        await(() -> queue.running() == 1);
        assertThat(queue.cancel("r")).isFalse(); // already started: runs to its end
        blocker.countDown();
        assertThat(running.get(5, TimeUnit.SECONDS)).isEqualTo("r");
    }

    @Test
    void aCancelThatOvertakesItsRequestDropsTheRequestOnArrival() {
        TtsQueue queue = new TtsQueue(1);
        queue.cancel("early");
        assertThatThrownBy(() -> queue.run("early", Priority.NOW, () -> "never"))
                .isInstanceOf(CancellationException.class);
    }

    @Test
    void concurrencyOneIsHonoured() throws Exception {
        TtsQueue queue = new TtsQueue(1);
        AtomicInteger active = new AtomicInteger();
        AtomicInteger maxActive = new AtomicInteger();
        List<CompletableFuture<Void>> all = new ArrayList<>();
        for (int i = 0; i < 8; i++) {
            Priority p = i % 2 == 0 ? Priority.NOW : Priority.PREFETCH;
            all.add(CompletableFuture.runAsync(() -> {
                try {
                    queue.run(null, p, () -> {
                        maxActive.accumulateAndGet(active.incrementAndGet(), Math::max);
                        try {
                            Thread.sleep(10);
                        } catch (InterruptedException e) {
                            Thread.currentThread().interrupt();
                        }
                        active.decrementAndGet();
                        return null;
                    });
                } catch (TtsException e) {
                    throw new RuntimeException(e);
                }
            }, r -> Thread.ofVirtual().start(r)));
        }
        CompletableFuture.allOf(all.toArray(CompletableFuture[]::new)).get(5, TimeUnit.SECONDS);
        assertThat(maxActive.get()).isEqualTo(1);
        assertThat(queue.running()).isZero();
        assertThat(queue.queued()).isZero();
    }

    @Test
    void higherConcurrencyRunsJobsSideBySide() throws Exception {
        TtsQueue queue = new TtsQueue(2);
        CountDownLatch blocker = new CountDownLatch(1);
        submit(queue, "a", Priority.NOW, blocker);
        submit(queue, "b", Priority.NOW, blocker);
        await(() -> queue.running() == 2);
        assertThat(queue.queued()).isZero();
        blocker.countDown();
    }

    @Test
    void aFailingJobFreesItsSlot() throws Exception {
        TtsQueue queue = new TtsQueue(1);
        assertThatThrownBy(() -> queue.run("x", Priority.NOW, () -> {
            throw new TtsException(TtsException.Reason.UPSTREAM_ERROR, "boom");
        })).isInstanceOf(TtsException.class);
        assertThat(queue.running()).isZero();
        assertThat(queue.run("y", Priority.NOW, () -> "ok")).isEqualTo("ok");
    }

    @Test
    void priorityParsing() throws TtsException {
        assertThat(Priority.parse(null)).isEqualTo(Priority.NOW);
        assertThat(Priority.parse(" ")).isEqualTo(Priority.NOW);
        assertThat(Priority.parse("Prefetch")).isEqualTo(Priority.PREFETCH);
        assertThat(Priority.parse("now")).isEqualTo(Priority.NOW);
        assertThatThrownBy(() -> Priority.parse("later")).isInstanceOf(TtsException.class);
    }
}
