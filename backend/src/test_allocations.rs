//! Thread-local allocation-volume instrumentation for isolated encoding benchmarks.
//! This allocator is never linked into a production build.
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

thread_local! {
    static COUNTING: Cell<bool> = const { Cell::new(false) };
    static BYTES: Cell<usize> = const { Cell::new(0) };
    static CALLS: Cell<usize> = const { Cell::new(0) };
}

struct CountingAllocator;

fn record(bytes: usize) {
    let _ = COUNTING.try_with(|enabled| {
        if enabled.get() {
            let _ = BYTES.try_with(|value| value.set(value.get().saturating_add(bytes)));
            let _ = CALLS.try_with(|value| value.set(value.get().saturating_add(1)));
        }
    });
}

// Every operation delegates the original pointer/layout to the system allocator.
unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        record(layout.size());
        unsafe { System.alloc(layout) }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        record(layout.size());
        unsafe { System.alloc_zeroed(layout) }
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        record(size);
        unsafe { System.realloc(pointer, layout, size) }
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        unsafe { System.dealloc(pointer, layout) }
    }
}

#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;

pub fn measure<T>(operation: impl FnOnce() -> T) -> (T, usize, usize) {
    struct Stop;
    impl Drop for Stop {
        fn drop(&mut self) {
            COUNTING.set(false);
        }
    }
    assert!(!COUNTING.get(), "allocation measurement must not nest");
    BYTES.set(0);
    CALLS.set(0);
    COUNTING.set(true);
    let stop = Stop;
    let result = operation();
    drop(stop);
    (result, BYTES.get(), CALLS.get())
}
