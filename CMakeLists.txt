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
)
target_include_directories(libchess PUBLIC libchess/include)

enable_testing()
add_executable(perft tests/perft.cpp)
target_link_libraries(perft PRIVATE libchess)
add_test(NAME perft COMMAND perft)
