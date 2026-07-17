#include "libchess/bitboard.h"

#include <cstddef>

namespace libchess {

Bitboard PawnAttacks[COLOR_NB][SQUARE_NB];
Bitboard KnightAttacks[SQUARE_NB];
Bitboard KingAttacks[SQUARE_NB];

namespace {

// A magic entry per square. The attack table for each square is a slice of a
// shared flat array (`attacks`).
struct Magic {
    Bitboard  mask;    // relevant occupancy bits
    Bitboard  magic;   // multiplier
    Bitboard* attacks; // pointer into the shared table
    int       shift;   // 64 - popcount(mask)

    unsigned index(Bitboard occ) const {
        return unsigned(((occ & mask) * magic) >> shift);
    }
};

Magic RookMagics[SQUARE_NB];
Magic BishopMagics[SQUARE_NB];
Bitboard RookTable[102400];
Bitboard BishopTable[5248];

bool g_initialized = false;

// Directions as (file, rank) deltas.
struct Delta { int df; int dr; };

// Slide from `s` in the given directions until the board edge or a blocker
// (blocker square itself is included as an attacked square).
Bitboard sliding_attack(Square s, Bitboard occ, const Delta* dirs, int n) {
    Bitboard attacks = 0;
    for (int i = 0; i < n; ++i) {
        int f = file_of(s) + dirs[i].df;
        int r = rank_of(s) + dirs[i].dr;
        while (f >= 0 && f <= 7 && r >= 0 && r <= 7) {
            Square t = make_square(f, r);
            attacks |= square_bb(t);
            if (occ & square_bb(t)) break;
            f += dirs[i].df;
            r += dirs[i].dr;
        }
    }
    return attacks;
}

const Delta ROOK_DIRS[4]   = {{1,0},{-1,0},{0,1},{0,-1}};
const Delta BISHOP_DIRS[4] = {{1,1},{1,-1},{-1,1},{-1,-1}};

// Relevant occupancy mask: like a full slide on an empty board, but excluding
// the board edges along each ray (edge squares never block further travel).
Bitboard slider_mask(Square s, const Delta* dirs, int n) {
    Bitboard mask = 0;
    for (int i = 0; i < n; ++i) {
        int f = file_of(s) + dirs[i].df;
        int r = rank_of(s) + dirs[i].dr;
        while (f >= 0 && f <= 7 && r >= 0 && r <= 7) {
            int nf = f + dirs[i].df;
            int nr = r + dirs[i].dr;
            if (nf < 0 || nf > 7 || nr < 0 || nr > 7) break; // drop the edge square
            mask |= square_bb(make_square(f, r));
            f = nf;
            r = nr;
        }
    }
    return mask;
}

// Deterministic xorshift64 PRNG for magic search. Fixed seed => reproducible.
struct Rng {
    uint64_t s;
    explicit Rng(uint64_t seed) : s(seed) {}
    uint64_t next() {
        s ^= s >> 12; s ^= s << 25; s ^= s >> 27;
        return s * 0x2545F4914F6CDD1DULL;
    }
    // Bias toward numbers with few set bits — better magic candidates.
    uint64_t sparse() { return next() & next() & next(); }
};

void init_magics(const Delta* dirs, Magic* magics, Bitboard* table) {
    Rng rng(0x1234567890ABCDEFULL);
    Bitboard occupancies[4096];
    Bitboard references[4096];
    size_t table_offset = 0;

    for (int sq = 0; sq < SQUARE_NB; ++sq) {
        Square s = Square(sq);
        Magic& m = magics[sq];
        m.mask = slider_mask(s, dirs, 4);
        m.shift = 64 - popcount(m.mask);
        m.attacks = table + table_offset;

        // Enumerate every subset of the mask (Carry-Rippler) and its attacks.
        int size = 0;
        Bitboard b = 0;
        do {
            occupancies[size] = b;
            references[size] = sliding_attack(s, b, dirs, 4);
            ++size;
            b = (b - m.mask) & m.mask;
        } while (b);
        table_offset += size;

        // Search for a magic that maps every subset without a destructive collision.
        for (;;) {
            Bitboard magic;
            do {
                magic = rng.sparse();
            } while (popcount((m.mask * magic) & 0xFF00000000000000ULL) < 6);
            m.magic = magic;

            for (int i = 0; i < size; ++i) m.attacks[i] = 0;
            bool ok = true;
            for (int i = 0; i < size && ok; ++i) {
                unsigned idx = m.index(occupancies[i]);
                if (m.attacks[idx] == 0)
                    m.attacks[idx] = references[i];
                else if (m.attacks[idx] != references[i])
                    ok = false; // destructive collision, try another magic
            }
            if (ok) break;
        }
    }
}

Bitboard pawn_attack_bb(Color c, Square s) {
    Bitboard att = 0;
    int f = file_of(s), r = rank_of(s);
    int dr = (c == WHITE) ? 1 : -1;
    if (r + dr >= 0 && r + dr <= 7) {
        if (f - 1 >= 0) att |= square_bb(make_square(f - 1, r + dr));
        if (f + 1 <= 7) att |= square_bb(make_square(f + 1, r + dr));
    }
    return att;
}

} // namespace

Bitboard rook_attacks(Square s, Bitboard occ) {
    const Magic& m = RookMagics[s];
    return m.attacks[m.index(occ)];
}

Bitboard bishop_attacks(Square s, Bitboard occ) {
    const Magic& m = BishopMagics[s];
    return m.attacks[m.index(occ)];
}

void init_attacks() {
    if (g_initialized) return;

    const Delta KNIGHT_D[8] = {{1,2},{2,1},{2,-1},{1,-2},{-1,-2},{-2,-1},{-2,1},{-1,2}};
    const Delta KING_D[8]   = {{1,0},{1,1},{0,1},{-1,1},{-1,0},{-1,-1},{0,-1},{1,-1}};

    for (int sq = 0; sq < SQUARE_NB; ++sq) {
        Square s = Square(sq);
        int f = file_of(s), r = rank_of(s);

        Bitboard kn = 0, kg = 0;
        for (int i = 0; i < 8; ++i) {
            int nf = f + KNIGHT_D[i].df, nr = r + KNIGHT_D[i].dr;
            if (nf >= 0 && nf <= 7 && nr >= 0 && nr <= 7)
                kn |= square_bb(make_square(nf, nr));
            nf = f + KING_D[i].df; nr = r + KING_D[i].dr;
            if (nf >= 0 && nf <= 7 && nr >= 0 && nr <= 7)
                kg |= square_bb(make_square(nf, nr));
        }
        KnightAttacks[sq] = kn;
        KingAttacks[sq] = kg;
        PawnAttacks[WHITE][sq] = pawn_attack_bb(WHITE, s);
        PawnAttacks[BLACK][sq] = pawn_attack_bb(BLACK, s);
    }

    init_magics(ROOK_DIRS, RookMagics, RookTable);
    init_magics(BISHOP_DIRS, BishopMagics, BishopTable);
    g_initialized = true;
}

} // namespace libchess
