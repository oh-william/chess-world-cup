// rs-alphabeta — the SAME iterative-deepening alpha-beta + quiescence + MVV-LVA
// over the SAME libchess eval as cpp-alphabeta / py-alphabeta, in Rust via the C
// ABI. Third point on the language-tax axis: a compiled language should pay ~no
// tax vs C++, in stark contrast to Python. Deterministic (no RNG).
use std::ffi::CString;
use std::io::{self, BufRead, Write};
use std::os::raw::{c_char, c_int, c_void};
use std::time::Instant;

#[allow(non_snake_case)]
extern "C" {
    fn lc_new() -> *mut c_void;
    fn lc_startpos(b: *mut c_void);
    fn lc_set_fen(b: *mut c_void, fen: *const c_char) -> c_int;
    fn lc_side_to_move(b: *mut c_void) -> c_int;
    fn lc_in_check(b: *mut c_void) -> c_int;
    fn lc_legal_moves(b: *mut c_void, out: *mut u16, max: c_int) -> c_int;
    fn lc_make(b: *mut c_void, m: u16);
    fn lc_unmake(b: *mut c_void, m: u16);
    fn lc_eval(b: *mut c_void) -> c_int;
    fn lc_piece_at(b: *mut c_void, sq: c_int) -> c_int;
    fn lc_move_to_uci(m: u16, buf: *mut c_char);
    fn lc_move_from_uci(b: *mut c_void, uci: *const c_char) -> u16;
}

const INF: i32 = 1_000_000;
const MATE: i32 = 30_000;
const MAX_PLY: i32 = 64;
const VAL: [i32; 6] = [100, 320, 330, 500, 900, 0];

struct Board(*mut c_void);
impl Board {
    fn new() -> Self { Board(unsafe { lc_new() }) }
    fn startpos(&self) { unsafe { lc_startpos(self.0) } }
    fn set_fen(&self, f: &str) { let c = CString::new(f).unwrap(); unsafe { lc_set_fen(self.0, c.as_ptr()); } }
    fn stm(&self) -> i32 { unsafe { lc_side_to_move(self.0) } }
    fn in_check(&self) -> bool { unsafe { lc_in_check(self.0) != 0 } }
    fn eval(&self) -> i32 { unsafe { lc_eval(self.0) } }
    fn piece_at(&self, sq: i32) -> i32 { unsafe { lc_piece_at(self.0, sq) } }
    fn make(&self, m: u16) { unsafe { lc_make(self.0, m) } }
    fn unmake(&self, m: u16) { unsafe { lc_unmake(self.0, m) } }
    fn legal(&self) -> Vec<u16> {
        let mut buf = [0u16; 256];
        let n = unsafe { lc_legal_moves(self.0, buf.as_mut_ptr(), 256) };
        buf[..n as usize].to_vec()
    }
    fn from_uci(&self, u: &str) -> u16 {
        let c = CString::new(u).unwrap();
        unsafe { lc_move_from_uci(self.0, c.as_ptr()) }
    }
    fn to_uci(&self, m: u16) -> String {
        let mut buf = [0i8; 6];
        unsafe { lc_move_to_uci(m, buf.as_mut_ptr()) };
        let bytes: Vec<u8> = buf.iter().take_while(|&&c| c != 0).map(|&c| c as u8).collect();
        String::from_utf8_lossy(&bytes).into_owned()
    }
}

fn mv_to(m: u16) -> i32 { ((m >> 6) & 0x3f) as i32 }
fn mv_from(m: u16) -> i32 { (m & 0x3f) as i32 }
fn mv_flag(m: u16) -> u16 { (m >> 14) & 0x3 } // 1 promo, 2 ep
fn mv_promo(m: u16) -> usize { (((m >> 12) & 0x3) + 1) as usize }

fn move_score(b: &Board, m: u16) -> i32 {
    let victim = b.piece_at(mv_to(m));
    let mut s = 0;
    if victim >= 0 { s += 100 * VAL[victim as usize] - VAL[b.piece_at(mv_from(m)) as usize]; }
    match mv_flag(m) { 1 => s += 100 * VAL[mv_promo(m)], 2 => s += 100 * VAL[0], _ => {} }
    s
}

fn order(b: &Board, mut moves: Vec<u16>, hint: u16) -> Vec<u16> {
    moves.sort_by_key(|&m| -(if m == hint { INF } else { move_score(b, m) }));
    moves
}

fn is_capture(b: &Board, m: u16) -> bool { b.piece_at(mv_to(m)) >= 0 || mv_flag(m) == 2 }

struct Ctx { nodes: u64, node_mode: bool, node_limit: u64, time_mode: bool, deadline: Instant, stop: bool }

impl Ctx {
    fn check(&mut self) {
        if self.node_mode && self.nodes >= self.node_limit { self.stop = true; }
        else if self.time_mode && (self.nodes & 2047) == 0 && Instant::now() >= self.deadline { self.stop = true; }
    }
}

fn quiesce(b: &Board, mut alpha: i32, beta: i32, ctx: &mut Ctx) -> i32 {
    ctx.nodes += 1;
    ctx.check();
    if ctx.stop { return alpha; }
    let stand = b.eval();
    if stand >= beta { return beta; }
    if stand > alpha { alpha = stand; }
    for m in order(b, b.legal(), 0) {
        if !is_capture(b, m) && mv_flag(m) != 1 { continue; }
        b.make(m);
        let score = -quiesce(b, -beta, -alpha, ctx);
        b.unmake(m);
        if ctx.stop { return alpha; }
        if score >= beta { return beta; }
        if score > alpha { alpha = score; }
    }
    alpha
}

fn negamax(b: &Board, depth: i32, ply: i32, mut alpha: i32, beta: i32, ctx: &mut Ctx) -> i32 {
    ctx.check();
    if ctx.stop { return 0; }
    if depth <= 0 { return quiesce(b, alpha, beta, ctx); }
    ctx.nodes += 1;
    let moves = b.legal();
    if moves.is_empty() { return if b.in_check() { -MATE + ply } else { 0 }; }
    let mut best = -INF;
    for m in order(b, moves, 0) {
        b.make(m);
        let score = -negamax(b, depth - 1, ply + 1, -beta, -alpha, ctx);
        b.unmake(m);
        if ctx.stop { return if best > -INF { best } else { alpha }; }
        if score > best { best = score; }
        if score > alpha { alpha = score; }
        if alpha >= beta { break; }
    }
    best
}

fn search(b: &Board, ms_left: i64, nodes_left: i64) -> (u16, u64) {
    let mut ctx = Ctx {
        nodes: 0,
        node_mode: nodes_left >= 0,
        node_limit: if nodes_left >= 0 { nodes_left as u64 } else { 0 },
        time_mode: ms_left >= 0,
        deadline: Instant::now() + std::time::Duration::from_millis(if ms_left >= 0 { (ms_left - 5).max(1) as u64 } else { 0 }),
        stop: false,
    };
    let root = b.legal();
    if root.is_empty() { return (0, 0); }
    if root.len() == 1 { return (root[0], 0); }

    let mut overall_best = root[0];
    let mut hint: u16 = 0;
    let mut depth = 1;
    while depth < MAX_PLY {
        let (mut alpha, beta) = (-INF, INF);
        let mut best_score = -INF;
        let mut local_best = 0u16;
        for m in order(b, root.clone(), hint) {
            b.make(m);
            let score = -negamax(b, depth - 1, 1, -beta, -alpha, &mut ctx);
            b.unmake(m);
            if ctx.stop { break; }
            if score > best_score { best_score = score; local_best = m; }
            if score > alpha { alpha = score; }
        }
        if ctx.stop { break; }
        overall_best = local_best;
        hint = local_best;
        if best_score >= MATE - MAX_PLY { break; }
        depth += 1;
    }
    (overall_best, ctx.nodes)
}

fn apply_position(b: &Board, tokens: &[&str]) {
    let mut i = 0;
    if tokens.first() == Some(&"startpos") { b.startpos(); i = 1; }
    else if tokens.first() == Some(&"fen") { b.set_fen(&tokens[1..7.min(tokens.len())].join(" ")); i = 7; }
    if let Some(pos) = tokens.iter().position(|&t| t == "moves") { i = pos + 1; }
    else { i = i.max(tokens.len()); }
    for &u in &tokens[i.min(tokens.len())..] {
        let m = b.from_uci(u);
        if m != 0 { b.make(m); }
    }
}

fn main() {
    let b = Board::new();
    let stdin = io::stdin();
    let mut out = io::stdout();
    for line in stdin.lock().lines() {
        let line = line.unwrap();
        let t: Vec<&str> = line.split_whitespace().collect();
        if t.is_empty() { continue; }
        match t[0] {
            "uci" => {
                let _ = write!(out, "id name rs-alphabeta\nid author chess-world-cup\nid lang Rust\nid family alpha-beta\nid country SE\nuciok\n");
                out.flush().unwrap();
            }
            "isready" => { let _ = write!(out, "readyok\n"); out.flush().unwrap(); }
            "ucinewgame" => b.startpos(),
            "position" => apply_position(&b, &t[1..]),
            "go" => {
                let (mut ms, mut nodes) = (-1i64, -1i64);
                let mut j = 1;
                while j + 1 < t.len() {
                    match t[j] { "movetime" => ms = t[j + 1].parse().unwrap_or(-1),
                                 "nodes" => nodes = t[j + 1].parse().unwrap_or(-1), _ => {} }
                    j += 1;
                }
                let t0 = Instant::now();
                let (best, n) = search(&b, ms, nodes);
                let elapsed = t0.elapsed().as_millis();
                let _ = write!(out, "info time {} nodes {}\nbestmove {}\n", elapsed, n, b.to_uci(best));
                out.flush().unwrap();
            }
            "quit" => break,
            _ => {}
        }
    }
}
