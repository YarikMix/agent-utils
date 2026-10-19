#!/usr/bin/env python3
"""List enabled macOS input sources using the read-only Text Input Source API."""

import ctypes as C
import json
import sys


def input_sources():
    if sys.platform != "darwin":
        raise RuntimeError("Input source discovery requires macOS")
    cf = C.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
    tis = C.CDLL("/System/Library/Frameworks/Carbon.framework/Carbon")
    cf.CFArrayGetCount.argtypes = [C.c_void_p]
    cf.CFArrayGetCount.restype = C.c_long
    cf.CFArrayGetValueAtIndex.argtypes = [C.c_void_p, C.c_long]
    cf.CFArrayGetValueAtIndex.restype = C.c_void_p
    cf.CFStringGetLength.argtypes = [C.c_void_p]
    cf.CFStringGetLength.restype = C.c_long
    cf.CFStringGetCString.argtypes = [C.c_void_p, C.c_void_p, C.c_long, C.c_uint32]
    cf.CFStringGetCString.restype = C.c_bool
    cf.CFRelease.argtypes = [C.c_void_p]
    tis.TISCreateInputSourceList.argtypes = [C.c_void_p, C.c_bool]
    tis.TISCreateInputSourceList.restype = C.c_void_p
    tis.TISGetInputSourceProperty.argtypes = [C.c_void_p, C.c_void_p]
    tis.TISGetInputSourceProperty.restype = C.c_void_p
    tis.TISCopyCurrentKeyboardInputSource.argtypes = []
    tis.TISCopyCurrentKeyboardInputSource.restype = C.c_void_p

    def prop(source, name):
        return tis.TISGetInputSourceProperty(source, C.c_void_p.in_dll(tis, name))

    def string(value):
        if not value:
            return None
        buffer = C.create_string_buffer(cf.CFStringGetLength(value) * 4 + 1)
        if not cf.CFStringGetCString(value, buffer, len(buffer), 0x08000100):
            raise RuntimeError("Cannot decode an input source property")
        return buffer.value.decode("utf-8")

    current = tis.TISCopyCurrentKeyboardInputSource()
    sources = tis.TISCreateInputSourceList(None, False)
    try:
        if not sources:
            raise RuntimeError("macOS returned no input source list")
        current_id = string(prop(current, "kTISPropertyInputSourceID")) if current else None
        result = []
        for index in range(cf.CFArrayGetCount(sources)):
            source = cf.CFArrayGetValueAtIndex(sources, index)
            category = string(prop(source, "kTISPropertyInputSourceCategory"))
            if category != "TISCategoryKeyboardInputSource":
                continue
            source_id = string(prop(source, "kTISPropertyInputSourceID"))
            languages = prop(source, "kTISPropertyInputSourceLanguages")
            result.append({
                "id": source_id,
                "name": string(prop(source, "kTISPropertyLocalizedName")),
                "languages": [string(cf.CFArrayGetValueAtIndex(languages, i))
                              for i in range(cf.CFArrayGetCount(languages))] if languages else [],
                "selected": source_id == current_id,
            })
        return result
    finally:
        if sources:
            cf.CFRelease(sources)
        if current:
            cf.CFRelease(current)


if __name__ == "__main__":
    try:
        print(json.dumps(input_sources(), ensure_ascii=False, indent=2))
    except (OSError, RuntimeError) as error:
        sys.exit(str(error))
