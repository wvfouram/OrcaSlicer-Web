// Serial stand-in for the oneTBB API surface the slicing engine uses, for the single-threaded
// WebAssembly build. A page opened as a local file has no SharedArrayBuffer, so it cannot run
// threads; every algorithm here runs its body on the calling thread, in order, with the same
// results the parallel versions produce (the engine never depends on a particular interleaving).
#pragma once

#include <algorithm>
#include <cstddef>
#include <functional>
#include <iterator>
#include <memory>
#include <mutex>
#include <type_traits>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>
#include <deque>

#define TBB_VERSION_MAJOR 2021
#define TBB_VERSION_MINOR 99
#define TBB_INTERFACE_VERSION 12999
#define TBB_SERIAL_SHIM 1

namespace tbb {

struct split {};
struct proportional_split { size_t left_ = 1, right_ = 1; size_t left() const { return left_; } size_t right() const { return right_; } };

// ---------------- ranges ----------------
template <typename Value>
class blocked_range {
public:
    using const_iterator = Value;
    using size_type      = std::size_t;
    blocked_range() = default;
    blocked_range(Value begin, Value end, size_type grainsize = 1) : m_begin(begin), m_end(end), m_grainsize(grainsize) {}
    blocked_range(blocked_range &r, split) : m_begin(r.m_begin), m_end(r.m_end), m_grainsize(r.m_grainsize) {
        Value middle = m_begin + (m_end - m_begin) / 2u;
        r.m_end = middle; m_begin = middle;
    }
    Value     begin() const { return m_begin; }
    Value     end() const { return m_end; }
    size_type size() const { return size_type(m_end - m_begin); }
    size_type grainsize() const { return m_grainsize; }
    bool      empty() const { return !(m_begin < m_end); }
    bool      is_divisible() const { return m_grainsize < size(); }
private:
    Value     m_begin{}, m_end{};
    size_type m_grainsize = 1;
};

template <typename RowValue, typename ColValue = RowValue>
class blocked_range2d {
public:
    using row_range_type = blocked_range<RowValue>;
    using col_range_type = blocked_range<ColValue>;
    blocked_range2d(RowValue row_begin, RowValue row_end, typename row_range_type::size_type row_grain,
                    ColValue col_begin, ColValue col_end, typename col_range_type::size_type col_grain)
        : m_rows(row_begin, row_end, row_grain), m_cols(col_begin, col_end, col_grain) {}
    blocked_range2d(RowValue row_begin, RowValue row_end, ColValue col_begin, ColValue col_end)
        : m_rows(row_begin, row_end), m_cols(col_begin, col_end) {}
    bool empty() const { return m_rows.empty() || m_cols.empty(); }
    bool is_divisible() const { return m_rows.is_divisible() || m_cols.is_divisible(); }
    const row_range_type &rows() const { return m_rows; }
    const col_range_type &cols() const { return m_cols; }
private:
    row_range_type m_rows;
    col_range_type m_cols;
};

// ---------------- partitioners (no effect when serial) ----------------
class simple_partitioner {};
class auto_partitioner {};
class static_partitioner {};
class affinity_partitioner {};

// ---------------- task groups and cancellation ----------------
namespace detail { inline bool &current_group_cancel_flag() { static bool flag = false; return flag; } }

class task_group_context {
public:
    enum kind_type { isolated, bound };
    task_group_context(kind_type = bound) {}
    bool cancel_group_execution() { bool was = m_cancelled; m_cancelled = true; return !was; }
    bool is_group_execution_cancelled() const { return m_cancelled; }
    void reset() { m_cancelled = false; }
private:
    bool m_cancelled = false;
};

enum task_group_status { not_complete, complete, canceled };

class task_group {
public:
    template <typename F> void run(F &&f) {
        if (m_cancelled) return;
        bool &flag = detail::current_group_cancel_flag();
        bool  saved = flag;
        flag = false;
        std::forward<F>(f)();
        if (flag) m_cancelled = true;
        flag = saved;
    }
    template <typename F> task_group_status run_and_wait(F &&f) { run(std::forward<F>(f)); return wait(); }
    task_group_status wait() { return m_cancelled ? canceled : complete; }
    void cancel() { m_cancelled = true; detail::current_group_cancel_flag() = true; }
    bool is_canceling() const { return m_cancelled; }
private:
    bool m_cancelled = false;
};
inline bool is_current_task_group_canceling() { return detail::current_group_cancel_flag(); }

// ---------------- parallel_for ----------------
// Range forms (Range is a blocked_range-like class; integral first/last are handled below).
template <typename Range> using enable_if_range_t = std::enable_if_t<!std::is_integral<std::decay_t<Range>>::value>;
template <typename Range, typename Body, typename = enable_if_range_t<Range>>
void parallel_for(const Range &range, const Body &body) { if (!range.empty()) body(range); }
template <typename Range, typename Body, typename Partitioner, typename = enable_if_range_t<Range>>
void parallel_for(const Range &range, const Body &body, Partitioner &&) { if (!range.empty()) body(range); }
template <typename Range, typename Body, typename Partitioner, typename = enable_if_range_t<Range>>
void parallel_for(const Range &range, const Body &body, Partitioner &&, task_group_context &) { if (!range.empty()) body(range); }

template <typename Index, typename Function,
          typename = std::enable_if_t<std::is_integral<Index>::value>>
void parallel_for(Index first, Index last, const Function &f) { for (Index i = first; i < last; ++i) f(i); }
template <typename Index, typename Function,
          typename = std::enable_if_t<std::is_integral<Index>::value>>
void parallel_for(Index first, Index last, Index step, const Function &f) { for (Index i = first; i < last; i += step) f(i); }
template <typename Index, typename Function, typename Partitioner,
          typename = std::enable_if_t<std::is_integral<Index>::value && !std::is_integral<std::decay_t<Partitioner>>::value>>
void parallel_for(Index first, Index last, const Function &f, Partitioner &&) { for (Index i = first; i < last; ++i) f(i); }

// ---------------- parallel_for_each ----------------
template <typename It, typename Body>
void parallel_for_each(It first, It last, const Body &body) { for (; first != last; ++first) body(*first); }
template <typename Container, typename Body>
void parallel_for_each(Container &c, const Body &body) { for (auto &v : c) body(v); }
template <typename Container, typename Body>
void parallel_for_each(const Container &c, const Body &body) { for (const auto &v : c) body(v); }

// ---------------- parallel_reduce ----------------
template <typename Range, typename Value, typename RealBody, typename Reduction>
Value parallel_reduce(const Range &range, const Value &identity, const RealBody &body, const Reduction &) {
    return range.empty() ? identity : body(range, identity);
}
template <typename Range, typename Value, typename RealBody, typename Reduction, typename Partitioner>
Value parallel_reduce(const Range &range, const Value &identity, const RealBody &body, const Reduction &, Partitioner &&) {
    return range.empty() ? identity : body(range, identity);
}
// Body-object form: body(range) accumulates, join() is never needed serially.
template <typename Range, typename Body>
void parallel_reduce(const Range &range, Body &body) { if (!range.empty()) body(range); }
template <typename Range, typename Body, typename Partitioner>
void parallel_reduce(const Range &range, Body &body, Partitioner &&) { if (!range.empty()) body(range); }
template <typename Range, typename Value, typename RealBody, typename Reduction>
Value parallel_deterministic_reduce(const Range &range, const Value &identity, const RealBody &body, const Reduction &r) {
    return parallel_reduce(range, identity, body, r);
}

// ---------------- parallel_sort / parallel_invoke ----------------
template <typename It> void parallel_sort(It first, It last) { std::sort(first, last); }
template <typename It, typename Compare> void parallel_sort(It first, It last, const Compare &comp) { std::sort(first, last, comp); }
template <typename Container> void parallel_sort(Container &c) { std::sort(std::begin(c), std::end(c)); }
template <typename... F> void parallel_invoke(F &&...f) { (std::forward<F>(f)(), ...); }

// ---------------- parallel_pipeline ----------------
enum class filter_mode { parallel, serial_in_order, serial_out_of_order };

class flow_control {
public:
    void stop() { m_stopped = true; }
    bool is_stopped() const { return m_stopped; }
private:
    bool m_stopped = false;
};

template <typename In, typename Out>
class filter {
public:
    filter() = default;
    template <typename F> filter(filter_mode, const F &f) : m_fn(make_fn(f)) {}
    explicit filter(std::function<Out(In, flow_control &)> fn) : m_fn(std::move(fn)) {}
    Out operator()(In in, flow_control &fc) const { return m_fn(std::move(in), fc); }
private:
    template <typename F> static std::function<Out(In, flow_control &)> make_fn(const F &f) {
        if constexpr (std::is_void_v<In>) {
            return [f](In, flow_control &fc) -> Out { return f(fc); };
        } else if constexpr (std::is_invocable_v<F, In, flow_control &>) {
            return [f](In in, flow_control &fc) -> Out { return f(std::move(in), fc); };
        } else {
            return [f](In in, flow_control &) -> Out { return f(std::move(in)); };
        }
    }
    std::function<Out(In, flow_control &)> m_fn;
};

// void-input specialisation: the first stage takes only the flow_control.
template <typename Out>
class filter<void, Out> {
public:
    filter() = default;
    template <typename F> filter(filter_mode, const F &f) : m_fn([f](flow_control &fc) -> Out { return f(fc); }) {}
    explicit filter(std::function<Out(flow_control &)> fn) : m_fn(std::move(fn)) {}
    Out operator()(flow_control &fc) const { return m_fn(fc); }
private:
    std::function<Out(flow_control &)> m_fn;
};

template <typename In, typename Out, typename F>
filter<In, Out> make_filter(filter_mode mode, const F &f) { return filter<In, Out>(mode, f); }

template <typename In, typename Mid, typename Out>
filter<In, Out> operator&(const filter<In, Mid> &a, const filter<Mid, Out> &b) {
    if constexpr (std::is_void_v<In>) {
        return filter<In, Out>(std::function<Out(flow_control &)>([a, b](flow_control &fc) -> Out {
            Mid m = a(fc);
            if (fc.is_stopped()) { if constexpr (std::is_void_v<Out>) return; else return Out{}; }
            if constexpr (std::is_void_v<Out>) b(std::move(m), fc); else return b(std::move(m), fc);
        }));
    } else {
        return filter<In, Out>(std::function<Out(In, flow_control &)>([a, b](In in, flow_control &fc) -> Out {
            if constexpr (std::is_void_v<Out>) b(a(std::move(in), fc), fc); else return b(a(std::move(in), fc), fc);
        }));
    }
}

inline void parallel_pipeline(std::size_t /*max_tokens*/, const filter<void, void> &chain) {
    for (;;) {
        flow_control fc;
        chain(fc);
        if (fc.is_stopped()) break;
    }
}
inline void parallel_pipeline(std::size_t max_tokens, const filter<void, void> &chain, task_group_context &) {
    parallel_pipeline(max_tokens, chain);
}

// ---------------- mutexes ----------------
class null_mutex {
public:
    void lock() {}
    bool try_lock() { return true; }
    void unlock() {}
    class scoped_lock {
    public:
        scoped_lock() = default;
        explicit scoped_lock(null_mutex &) {}
        void acquire(null_mutex &) {}
        bool try_acquire(null_mutex &) { return true; }
        void release() {}
    };
};
using spin_mutex       = null_mutex;
using mutex            = null_mutex;
using queuing_mutex    = null_mutex;
using spin_rw_mutex    = null_mutex;
using speculative_spin_mutex = null_mutex;

// ---------------- containers ----------------
template <typename T, typename Alloc = std::allocator<T>>
class concurrent_vector : public std::deque<T, Alloc> {
    // A deque keeps element addresses stable on push_back, which concurrent_vector guarantees too.
    using base = std::deque<T, Alloc>;
public:
    using base::base;
    using iterator = typename base::iterator;
    iterator push_back(const T &v) { base::push_back(v); return std::prev(base::end()); }
    iterator push_back(T &&v) { base::push_back(std::move(v)); return std::prev(base::end()); }
    template <typename... Args> iterator emplace_back(Args &&...args) { base::emplace_back(std::forward<Args>(args)...); return std::prev(base::end()); }
    iterator grow_by(std::size_t n) { std::size_t old = base::size(); base::resize(old + n); return base::begin() + old; }
    iterator grow_by(std::size_t n, const T &v) { std::size_t old = base::size(); base::resize(old + n, v); return base::begin() + old; }
    iterator grow_to_at_least(std::size_t n) { if (base::size() < n) base::resize(n); return base::begin() + n; }
};

template <typename K, typename V, typename H = std::hash<K>, typename E = std::equal_to<K>, typename A = std::allocator<std::pair<const K, V>>>
class concurrent_unordered_map : public std::unordered_map<K, V, H, E, A> {
    using base = std::unordered_map<K, V, H, E, A>;
public:
    using base::base;
    typename base::size_type unsafe_erase(const K &k) { return base::erase(k); }
    typename base::iterator  unsafe_erase(typename base::const_iterator it) { return base::erase(it); }
};
template <typename K, typename H = std::hash<K>, typename E = std::equal_to<K>, typename A = std::allocator<K>>
class concurrent_unordered_set : public std::unordered_set<K, H, E, A> {
    using base = std::unordered_set<K, H, E, A>;
public:
    using base::base;
    typename base::size_type unsafe_erase(const K &k) { return base::erase(k); }
};

template <typename T> using scalable_allocator = std::allocator<T>;
template <typename T> using cache_aligned_allocator = std::allocator<T>;

template <typename T>
class enumerable_thread_specific {
public:
    enumerable_thread_specific() = default;
    explicit enumerable_thread_specific(const T &init) : m_value(init) {}
    T &local() { return m_value; }
    T &local(bool &exists) { exists = true; return m_value; }
    T *begin() { return &m_value; }
    T *end() { return &m_value + 1; }
    std::size_t size() const { return 1; }
    template <typename F> T combine(F f) const { (void) f; return m_value; }
    template <typename F> void combine_each(F f) const { f(m_value); }
private:
    T m_value{};
};
template <typename T> using combinable = enumerable_thread_specific<T>;

// ---------------- scheduler controls ----------------
class global_control {
public:
    enum parameter { max_allowed_parallelism, thread_stack_size, terminate_on_exception };
    global_control(parameter, std::size_t) {}
    static std::size_t active_value(parameter p) { return p == max_allowed_parallelism ? 1 : 0; }
};

class task_arena {
public:
    static constexpr int automatic = -1;
    task_arena(int = automatic, unsigned = 1) {}
    void initialize() {}
    void initialize(int, unsigned = 1) {}
    template <typename F> auto execute(F &&f) -> decltype(f()) { return std::forward<F>(f)(); }
    template <typename F> void enqueue(F &&f) { std::forward<F>(f)(); }
    int max_concurrency() const { return 1; }
};

namespace this_task_arena {
inline int max_concurrency() { return 1; }
inline int current_thread_index() { return 0; }
template <typename F> auto isolate(F &&f) -> decltype(f()) { return std::forward<F>(f)(); }
}

class task_scheduler_init {
public:
    static constexpr int automatic = -1;
    explicit task_scheduler_init(int = automatic) {}
    static int default_num_threads() { return 1; }
};

class tick_count {
public:
    class interval_t {
    public:
        explicit interval_t(double s = 0) : m_s(s) {}
        double seconds() const { return m_s; }
    private:
        double m_s;
    };
    static tick_count now() { return tick_count(); }
    interval_t operator-(const tick_count &) const { return interval_t(0); }
};

} // namespace tbb

namespace oneapi { namespace tbb { using namespace ::tbb; } }
