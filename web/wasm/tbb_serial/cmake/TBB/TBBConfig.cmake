# find_package(TBB) for the serial shim: a header-only TBB::tbb (and TBB::tbbmalloc) target.
get_filename_component(_tbb_serial_root "${CMAKE_CURRENT_LIST_DIR}/../.." ABSOLUTE)
if (NOT TARGET TBB::tbb)
    add_library(TBB::tbb INTERFACE IMPORTED)
    set_target_properties(TBB::tbb PROPERTIES INTERFACE_INCLUDE_DIRECTORIES "${_tbb_serial_root}/include"
                                              INTERFACE_COMPILE_DEFINITIONS "TBB_SERIAL_SHIM=1")
    add_library(TBB::tbbmalloc INTERFACE IMPORTED)
    add_library(TBB::tbbmalloc_proxy INTERFACE IMPORTED)
endif ()
set(TBB_FOUND TRUE)
set(TBB_VERSION 2021.99)
set(TBB_INCLUDE_DIRS "${_tbb_serial_root}/include")
set(TBB_LIBRARIES TBB::tbb)
