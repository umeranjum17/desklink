
#ifndef LIBINPUTTINO_EXPORT_H
#define LIBINPUTTINO_EXPORT_H

#ifdef LIBINPUTTINO_STATIC_DEFINE
#  define LIBINPUTTINO_EXPORT
#  define LIBINPUTTINO_NO_EXPORT
#else
#  ifndef LIBINPUTTINO_EXPORT
#    ifdef libinputtino_EXPORTS
        /* We are building this library */
#      define LIBINPUTTINO_EXPORT 
#    else
        /* We are using this library */
#      define LIBINPUTTINO_EXPORT 
#    endif
#  endif

#  ifndef LIBINPUTTINO_NO_EXPORT
#    define LIBINPUTTINO_NO_EXPORT 
#  endif
#endif

#ifndef LIBINPUTTINO_DEPRECATED
#  define LIBINPUTTINO_DEPRECATED __attribute__ ((__deprecated__))
#endif

#ifndef LIBINPUTTINO_DEPRECATED_EXPORT
#  define LIBINPUTTINO_DEPRECATED_EXPORT LIBINPUTTINO_EXPORT LIBINPUTTINO_DEPRECATED
#endif

#ifndef LIBINPUTTINO_DEPRECATED_NO_EXPORT
#  define LIBINPUTTINO_DEPRECATED_NO_EXPORT LIBINPUTTINO_NO_EXPORT LIBINPUTTINO_DEPRECATED
#endif

/* NOLINTNEXTLINE(readability-avoid-unconditional-preprocessor-if) */
#if 0 /* DEFINE_NO_DEPRECATED */
#  ifndef LIBINPUTTINO_NO_DEPRECATED
#    define LIBINPUTTINO_NO_DEPRECATED
#  endif
#endif

#endif /* LIBINPUTTINO_EXPORT_H */
