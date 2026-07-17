cmake_minimum_required(VERSION 3.16)
project(chess_world_cup CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()
set(CMAKE_CXX_FLAGS_RELEASE "-O3 -DNDEBUG")

add_library(libchess STATIC
  libchess/src/bitboard.cpp
  libchess/src/board.cpp
  libchess/src/uci.cpp
)
target_include_directories(libchess PUBLIC libchess/include)

# Shared C ABI for FFI bots (Python/etc. load this via their runtime's FFI).
add_library(libchess_c SHARED libchess/src/c_api.cpp)
target_link_libraries(libchess_c PRIVATE libchess)
target_include_directories(libchess_c PUBLIC libchess/include)

# C++ UCI shim — bots link this and implement meta()/search().
add_library(shim_cpp STATIC shim/cpp/shim.cpp)
target_include_directories(shim_cpp PUBLIC shim/cpp)
target_link_libraries(shim_cpp PUBLIC libchess)

# Engines.
add_executable(random bots/random/random.cpp)
target_link_libraries(random PRIVATE shim_cpp)

add_executable(cpp-alphabeta bots/cpp-alphabeta/alphabeta.cpp)
target_include_directories(cpp-alphabeta PRIVATE bots/cpp-alphabeta)
target_link_libraries(cpp-alphabeta PRIVATE shim_cpp)

add_executable(cpp-greedy bots/cpp-greedy/greedy.cpp)
target_include_directories(cpp-greedy PRIVATE bots/cpp-alphabeta) # shares eval.h
target_link_libraries(cpp-greedy PRIVATE shim_cpp)

# Orchestrator.
add_executable(orchestrator orchestrator/orchestrator.cpp orchestrator/process.cpp)
target_link_libraries(orchestrator PRIVATE libchess)

enable_testing()
add_executable(perft tests/perft.cpp)
target_link_libraries(perft PRIVATE libchess)
add_test(NAME perft COMMAND perft)
