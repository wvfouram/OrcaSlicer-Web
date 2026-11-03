#!/usr/bin/env bash
# Builds the slicing engine's third-party libraries for WebAssembly (single-threaded, static).
# Run inside an Emscripten environment (emcmake/emconfigure on PATH).
#
#   web/wasm/build_deps.sh <prefix> [dep ...]
#
# Each library installs into <prefix>. A library that is already installed (marker file present)
# is skipped, so a cached prefix only rebuilds what changed. A failing library does not stop the
# others: the summary at the end (and <prefix>/status.txt) lists what built, so one CI run shows
# the state of every dependency.
set -u
PREFIX=$(realpath -m "${1:?usage: build_deps.sh <prefix> [dep ...]}"); shift
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=${WORK:-$PWD/wasm-deps-work}
JOBS=${JOBS:-$(nproc)}
mkdir -p "$PREFIX" "$WORK/logs"
STATUS="$PREFIX/status.txt"
: > "$WORK/summary.txt"

ALL=(zlib png jpeg boost gmp mpfr eigen cgal cereal nlopt draco libnoise opencv assimp occt blosc imath openexr openvdb slvs)
DEPS=("${@:-${ALL[@]}}")

export CFLAGS="-O2 -fexceptions" CXXFLAGS="-O2 -fexceptions" LDFLAGS="-fexceptions"
CMAKE_COMMON=(-DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$PREFIX" -DCMAKE_PREFIX_PATH="$PREFIX"
              -DCMAKE_FIND_ROOT_PATH="$PREFIX" -DBUILD_SHARED_LIBS=OFF -DCMAKE_POSITION_INDEPENDENT_CODE=OFF
              -DCMAKE_C_FLAGS="$CFLAGS" -DCMAKE_CXX_FLAGS="$CXXFLAGS" -DCMAKE_EXE_LINKER_FLAGS="$LDFLAGS"
              -DCMAKE_POLICY_VERSION_MINIMUM=3.5)

fetch() { # url dir
    local url=$1 dir=$2 file="$WORK/dl/$(basename "${1%%\?*}")"
    mkdir -p "$WORK/dl"
    [ -f "$file" ] || curl -fsSL --retry 4 -o "$file" "$url" || return 1
    rm -rf "$WORK/src/$dir"; mkdir -p "$WORK/src/$dir"
    case "$file" in
        *.zip) unzip -q "$file" -d "$WORK/src/$dir.tmp" ;;
        *) mkdir -p "$WORK/src/$dir.tmp" && tar -xf "$file" -C "$WORK/src/$dir.tmp" ;;
    esac || return 1
    # Strip the single top-level folder of the archive.
    local inner; inner=$(find "$WORK/src/$dir.tmp" -mindepth 1 -maxdepth 1)
    if [ "$(echo "$inner" | wc -l)" = 1 ] && [ -d "$inner" ]; then mv "$inner"/* "$inner"/.[!.]* "$WORK/src/$dir"/ 2>/dev/null; else mv "$WORK/src/$dir.tmp"/* "$WORK/src/$dir"/; fi
    rm -rf "$WORK/src/$dir.tmp"
    cd "$WORK/src/$dir"
}

cmake_build() { # srcdir [cmake args...]
    local src=$1; shift
    emcmake cmake -S "$src" -B "$src/_build" "${CMAKE_COMMON[@]}" "$@" && cmake --build "$src/_build" -j"$JOBS" && cmake --install "$src/_build"
}

build_zlib()    { fetch https://github.com/madler/zlib/archive/refs/tags/v1.2.11.zip zlib && cmake_build . ; }
build_png()     { fetch https://github.com/glennrp/libpng/archive/refs/tags/v1.6.59.zip png && cmake_build . -DPNG_SHARED=OFF -DPNG_TESTS=OFF -DPNG_TOOLS=OFF -DPNG_HARDWARE_OPTIMIZATIONS=OFF ; }
build_jpeg()    { fetch https://github.com/libjpeg-turbo/libjpeg-turbo/archive/refs/tags/3.2.0.zip jpeg && cmake_build . -DENABLE_SHARED=OFF -DWITH_SIMD=OFF -DWITH_TURBOJPEG=OFF ; }
build_eigen()   { fetch https://gitlab.com/libeigen/eigen/-/archive/5.0.1/eigen-5.0.1.zip eigen && cmake_build . -DEIGEN_BUILD_TESTING=OFF -DBUILD_TESTING=OFF -DEIGEN_BUILD_DOC=OFF ; }
build_cereal()  { fetch https://github.com/USCiLab/cereal/archive/refs/tags/v1.3.0.zip cereal && cmake_build . -DJUST_INSTALL_CEREAL=ON ; }
build_nlopt()   { fetch https://github.com/stevengj/nlopt/archive/v2.5.0.tar.gz nlopt && cmake_build . -DNLOPT_PYTHON=OFF -DNLOPT_OCTAVE=OFF -DNLOPT_MATLAB=OFF -DNLOPT_GUILE=OFF -DNLOPT_SWIG=OFF -DNLOPT_TESTS=OFF ; }
build_draco()   { fetch https://github.com/google/draco/archive/refs/tags/1.5.7.zip draco && EMSCRIPTEN="$EMSDK/upstream/emscripten" cmake_build . -DDRACO_JS_GLUE=OFF -DDRACO_WASM=OFF -DDRACO_TESTS=OFF -DDRACO_BUILD_EXECUTABLES=OFF ; }
build_libnoise(){ fetch https://github.com/SoftFever/Orca-deps-libnoise/archive/refs/tags/1.0.zip libnoise && cmake_build . -DBUILD_LIBNOISE_DOCUMENTATION=OFF -DBUILD_LIBNOISE_EXAMPLES=OFF ; }
build_slvs()    { fetch https://github.com/JacobStoren/SolveSpaceLib/archive/4d8704523e4bf212fadf5189f92484244f670fea.zip slvs && cmake_build . ; }
build_cgal()    { fetch https://github.com/CGAL/cgal/releases/download/v6.2.1/CGAL-6.2.1.zip cgal && cmake_build . -DCGAL_DISABLE_GMP=OFF -DWITH_CGAL_Qt6=OFF ; }

build_boost() {
    # Boost's own CMake build; b2's emscripten toolset emits objects current emcc can't read.
    fetch https://github.com/boostorg/boost/releases/download/boost-1.84.0/boost-1.84.0-cmake.tar.gz boost || return 1
    cmake_build . -DBOOST_INCLUDE_LIBRARIES="system;filesystem;thread;log;locale;regex;chrono;atomic;date_time;iostreams;program_options;nowide;algorithm;geometry;multiprecision;polygon;spirit;beast;asio;property_tree;uuid;bimap;dll;process" \
        -DBOOST_LOCALE_ENABLE_ICU=OFF -DBOOST_LOCALE_ENABLE_ICONV=OFF -DBOOST_IOSTREAMS_ENABLE_BZIP2=OFF \
        -DBOOST_IOSTREAMS_ENABLE_LZMA=OFF -DBOOST_IOSTREAMS_ENABLE_ZSTD=OFF -DBOOST_IOSTREAMS_ENABLE_ZLIB=ON -DBUILD_TESTING=OFF
}

build_gmp() {
    fetch https://ftp.gnu.org/gnu/gmp/gmp-6.3.0.tar.xz gmp || return 1
    emconfigure ./configure --host=none --disable-assembly --enable-cxx --disable-shared --enable-static --prefix="$PREFIX" \
        CC_FOR_BUILD=gcc && emmake make -j"$JOBS" && emmake make install
}
build_mpfr() {
    fetch https://ftp.gnu.org/gnu/mpfr/mpfr-4.2.2.tar.bz2 mpfr || return 1
    emconfigure ./configure --host=none --disable-shared --enable-static --with-gmp="$PREFIX" --prefix="$PREFIX" \
        && emmake make -j"$JOBS" && emmake make install
}

build_opencv() {
    # The engine uses OpenCV for texture-to-colour import only: core + imgproc is enough.
    fetch https://github.com/opencv/opencv/archive/refs/tags/4.14.0.tar.gz opencv || return 1
    cmake_build . -DBUILD_LIST=core,imgproc -DBUILD_opencv_world=OFF -DBUILD_TESTS=OFF -DBUILD_PERF_TESTS=OFF -DBUILD_EXAMPLES=OFF \
        -DBUILD_opencv_apps=OFF -DWITH_PTHREADS_PF=OFF -DCV_ENABLE_INTRINSICS=OFF -DCPU_BASELINE= -DCPU_DISPATCH= -DWITH_IPP=OFF \
        -DWITH_ITT=OFF -DWITH_OPENCL=OFF -DWITH_EIGEN=OFF -DWITH_PROTOBUF=OFF -DBUILD_ZLIB=OFF -DWITH_ADE=OFF -DWITH_LAPACK=OFF \
        -DBUILD_JAVA=OFF -DBUILD_opencv_python3=OFF -DBUILD_opencv_js=OFF -DOPENCV_GENERATE_PKGCONFIG=OFF
}
build_assimp() {
    fetch https://github.com/assimp/assimp/archive/refs/tags/v5.4.3.tar.gz assimp || return 1
    cmake_build . -DASSIMP_BUILD_TESTS=OFF -DASSIMP_BUILD_ASSIMP_TOOLS=OFF -DASSIMP_BUILD_ZLIB=OFF -DASSIMP_NO_EXPORT=ON \
        -DASSIMP_WARNINGS_AS_ERRORS=OFF -DASSIMP_INSTALL_PDB=OFF -DASSIMP_BUILD_ALL_IMPORTERS_BY_DEFAULT=OFF \
        -DASSIMP_BUILD_GLTF_IMPORTER=ON -DASSIMP_BUILD_FBX_IMPORTER=ON -DASSIMP_BUILD_OBJ_IMPORTER=ON -DASSIMP_BUILD_PLY_IMPORTER=ON
}
build_occt() {
    # STEP import only: no visualisation stack (OpenGL, FreeType, Tk), no Draw test harness.
    fetch https://github.com/Open-Cascade-SAS/OCCT/archive/refs/tags/V8_0_1.zip occt || return 1
    cmake_build . -DBUILD_LIBRARY_TYPE=Static -DBUILD_MODULE_Draw=OFF -DBUILD_MODULE_Visualization=OFF -DBUILD_MODULE_ApplicationFramework=ON \
        -DBUILD_MODULE_DataExchange=ON -DBUILD_MODULE_ModelingAlgorithms=ON -DBUILD_MODULE_ModelingData=ON -DUSE_FREETYPE=OFF \
        -DUSE_TK=OFF -DUSE_OPENGL=OFF -DUSE_GLES2=OFF -DUSE_FREEIMAGE=OFF -DUSE_TBB=OFF -DUSE_VTK=OFF -DUSE_RAPIDJSON=OFF \
        -DBUILD_DOC_Overview=OFF -DBUILD_SAMPLES_QT=OFF -DINSTALL_DIR_LAYOUT=Unix
}
build_blosc()   { fetch https://github.com/Blosc/c-blosc/archive/refs/tags/v1.17.0.zip blosc && cmake_build . -DBUILD_SHARED=OFF -DBUILD_TESTS=OFF -DBUILD_BENCHMARKS=OFF -DDEACTIVATE_SNAPPY=ON -DDEACTIVATE_AVX2=ON -DDEACTIVATE_SSE2=ON -DPREFER_EXTERNAL_ZLIB=ON ; }
build_imath()   { fetch https://github.com/AcademySoftwareFoundation/Imath/archive/refs/tags/v3.1.11.tar.gz imath && cmake_build . -DBUILD_TESTING=OFF -DPYTHON=OFF ; }
build_openexr() { fetch https://github.com/AcademySoftwareFoundation/openexr/archive/refs/tags/v2.5.5.zip openexr && cmake_build . -DBUILD_TESTING=OFF -DINSTALL_OPENEXR_EXAMPLES=OFF -DOPENEXR_BUILD_EXAMPLES=OFF -DOPENEXR_BUILD_UTILS=OFF -DPYILMBASE_ENABLE=OFF -DOPENEXR_VIEWERS_ENABLE=OFF -DILMBASE_PACKAGE_PREFIX="$PREFIX" ; }
build_openvdb() {
    fetch https://github.com/tamasmeszaros/openvdb/archive/a68fd58d0e2b85f01adeb8b13d7555183ab10aa5.zip openvdb || return 1
    cmake_build . -DOPENVDB_BUILD_CORE=ON -DOPENVDB_CORE_SHARED=OFF -DOPENVDB_CORE_STATIC=ON -DOPENVDB_BUILD_BINARIES=OFF \
        -DOPENVDB_BUILD_PYTHON_MODULE=OFF -DOPENVDB_BUILD_UNITTESTS=OFF -DUSE_BLOSC=ON -DUSE_ZLIB=ON -DUSE_LOG4CPLUS=OFF \
        -DUSE_EXR=OFF -DOPENVDB_ENABLE_3_ABI_COMPATIBLE=OFF -DTBB_DIR="$HERE/tbb_serial/cmake/TBB" -DTBB_ROOT="$HERE/tbb_serial" \
        -DBoost_USE_STATIC_LIBS=ON -DCMAKE_CXX_FLAGS="$CXXFLAGS -I$HERE/tbb_serial/include"
}

for dep in "${DEPS[@]}"; do
    marker="$PREFIX/.built-$dep"
    if [ -f "$marker" ]; then echo "$dep: cached" | tee -a "$WORK/summary.txt"; continue; fi
    echo "::group::$dep"
    start=$(date +%s)
    if ( set -o pipefail; "build_$dep" 2>&1 | tee "$WORK/logs/$dep.log" | tail -n 40 ); then
        touch "$marker"; echo "$dep: built in $(( $(date +%s) - start ))s" | tee -a "$WORK/summary.txt"
    else
        echo "$dep: FAILED (see logs/$dep.log)" | tee -a "$WORK/summary.txt"
    fi
    echo "::endgroup::"
    cd "$WORK"
done
cp "$WORK/summary.txt" "$STATUS"
echo "==== WebAssembly dependency summary ===="; cat "$WORK/summary.txt"
